-- ============================================================
-- ResellerOS — central document numbering system
-- Migration: 0004_document_series.sql
-- ============================================================
-- Purpose
--   Indian GST law (CGST Section 31 + Rule 46/53) requires every issued
--   document — Tax Invoice, Receipt Voucher, Refund Voucher, Credit Note,
--   Debit Note — to have a unique, sequential, per-fiscal-year number with
--   no gaps. Today's code uses Math.random() (illegal + collision-prone) for
--   invoices and a non-atomic count(*) for receipt vouchers.
--
--   This migration creates ONE central system for all document numbering.
--
-- What it solves
--   ✓ Sequential per-tenant per-fiscal-year (resets each Apr 1)
--   ✓ Race-safe atomic increment via UPSERT row-lock
--   ✓ Indian FY-aware: Apr-Mar (not calendar Jan-Dec)
--   ✓ Format: PREFIX-YYYY-YY-NNNN (e.g., INV-2025-26-0001)
--   ✓ Configurable prefix per tenant (future white-label)
--   ✓ Backfilled — existing RV-2026-NNNN numbers continue from current max
--   ✓ Single source of truth for: invoice, receipt_voucher, refund_voucher,
--     credit_note, debit_note, quote
--
-- API
--   select public.next_document_number('invoice');
--     → 'INV-2025-26-0042'
--
--   select public.next_document_number('receipt_voucher');
--     → 'RV-2025-26-0008'
-- ============================================================

begin;

-- ============================================================
-- 1. document_series — central ledger for all numbering counters
-- ============================================================
create table if not exists public.document_series (
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  doc_type     text not null,
  fiscal_year  text not null,           -- 'FY2526' (Apr 2025 - Mar 2026)
  prefix       text not null,           -- 'INV', 'RV', 'RFV', 'CN', 'DN', 'Q'
  last_number  integer not null default 0 check (last_number >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, doc_type, fiscal_year),
  check (doc_type in ('invoice','receipt_voucher','refund_voucher','credit_note','debit_note','quote'))
);

comment on table  public.document_series is
  'Per-tenant per-FY counter for every GST document type. Mutated only via next_document_number() RPC.';
comment on column public.document_series.fiscal_year is
  'Indian FY format: FY{YY1}{YY2} — e.g. FY2526 means April 2025 to March 2026';
comment on column public.document_series.last_number is
  'Highest sequential number issued in this (tenant, doc_type, fiscal_year). Next issued = last_number + 1.';

create index if not exists document_series_tenant_idx on public.document_series(tenant_id);

-- ============================================================
-- 2. RLS — owners + service role can read, writes only via RPC
-- ============================================================
alter table public.document_series enable row level security;

create policy "document_series_select" on public.document_series
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

-- No INSERT/UPDATE policies for authenticated users — counters mutate
-- ONLY through next_document_number() (security definer) to guarantee
-- atomic increment + prevent tampering with the legal series.

create policy "document_series_service_role" on public.document_series
  to service_role
  using (true)
  with check (true);

-- ============================================================
-- 3. Helper — compute Indian fiscal year for a given date
--    FY runs April 1 → March 31. A date in Jan-Mar belongs to FY
--    ending that year (FY of previous_year-current_year). Apr-Dec
--    belongs to FY ending next year (FY of current_year-next_year).
-- ============================================================
create or replace function public.indian_fiscal_year(p_date date default current_date)
returns text
language sql
immutable
as $$
  select case
    when extract(month from p_date) >= 4
      then 'FY' || to_char(p_date, 'YY') || to_char(p_date + interval '1 year', 'YY')
    else 'FY' || to_char(p_date - interval '1 year', 'YY') || to_char(p_date, 'YY')
  end;
$$;

comment on function public.indian_fiscal_year(date) is
  'Returns Indian FY label (FY2526) for the given date. Pure function — useful in queries + RPC.';

-- ============================================================
-- 4. Helper — default prefix per doc_type
-- ============================================================
create or replace function public.default_doc_prefix(p_doc_type text)
returns text
language sql
immutable
as $$
  select case p_doc_type
    when 'invoice'         then 'INV'
    when 'receipt_voucher' then 'RV'
    when 'refund_voucher'  then 'RFV'
    when 'credit_note'     then 'CN'
    when 'debit_note'      then 'DN'
    when 'quote'           then 'Q'
    else upper(p_doc_type)
  end;
$$;

-- ============================================================
-- 5. Helper — format a document number from its parts
--    Format: {PREFIX}-{YYYY}-{YY}-{NNNN}
--    e.g.    INV-2025-26-0001
--    Width 4 (10,000 docs / FY / tenant) — bump to 5 later if needed
-- ============================================================
create or replace function public.format_document_number(
  p_prefix      text,
  p_fiscal_year text,         -- 'FY2526'
  p_number      integer
)
returns text
language sql
immutable
as $$
  -- Split 'FY2526' into '2025' and '26'  →  '2025-26'
  select p_prefix || '-20' || substring(p_fiscal_year from 3 for 2)
       || '-' || substring(p_fiscal_year from 5 for 2)
       || '-' || lpad(p_number::text, 4, '0');
$$;

-- ============================================================
-- 6. THE atomic numbering RPC
--    Race-safe via INSERT ... ON CONFLICT DO UPDATE which takes a
--    row-level lock. Two concurrent callers cannot get same number.
-- ============================================================
create or replace function public.next_document_number(
  p_doc_type  text,
  p_tenant_id uuid default null  -- if null, derives from auth context
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id   uuid;
  v_fy          text;
  v_prefix      text;
  v_next_number integer;
begin
  -- Resolve tenant
  v_tenant_id := coalesce(p_tenant_id, public.current_tenant_id());
  if v_tenant_id is null then
    raise exception 'No tenant context — next_document_number requires authenticated session or explicit tenant_id';
  end if;

  -- Validate doc_type
  if p_doc_type not in ('invoice','receipt_voucher','refund_voucher','credit_note','debit_note','quote') then
    raise exception 'Invalid doc_type: %', p_doc_type;
  end if;

  v_fy     := public.indian_fiscal_year();
  v_prefix := public.default_doc_prefix(p_doc_type);

  -- Atomic UPSERT — creates the row on first call of the FY, increments after
  insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values (v_tenant_id, p_doc_type, v_fy, v_prefix, 1)
  on conflict (tenant_id, doc_type, fiscal_year)
  do update set
    last_number = document_series.last_number + 1,
    updated_at  = now()
  returning last_number into v_next_number;

  return public.format_document_number(v_prefix, v_fy, v_next_number);
end;
$$;

comment on function public.next_document_number(text, uuid) is
  'Atomically issues the next sequential document number for the given doc_type. Use for invoices, receipt vouchers, refund vouchers, credit notes, debit notes.';

-- Allow authenticated users to call the RPC (RLS on document_series still applies for direct selects)
grant execute on function public.next_document_number(text, uuid) to authenticated;
grant execute on function public.next_document_number(text, uuid) to service_role;
grant execute on function public.indian_fiscal_year(date) to authenticated, anon, service_role;
grant execute on function public.default_doc_prefix(text) to authenticated, anon, service_role;
grant execute on function public.format_document_number(text, text, integer) to authenticated, anon, service_role;

-- ============================================================
-- 7. Backfill — seed document_series from existing receipt vouchers
--    so the next issued RV continues from current max, no collisions.
--
--    Existing format: RV-YYYY-NNNN (calendar year). We extract YYYY,
--    infer FY (assume RV issued before Apr = FY{YY-1}{YY}, else
--    FY{YY}{YY+1}), and seed last_number.
--
--    NOTE: invoice IDs are random (Math.random()) so no useful info to
--    extract. New invoices will simply start from INV-…-0001 — old
--    invoices keep their random IDs unchanged. That's fine: GST law
--    only requires sequential within FY going forward, not retroactive.
-- ============================================================
do $$
declare
  r record;
  v_fy text;
  v_year int;
  v_number int;
begin
  for r in
    select tenant_id, receipt_voucher_no, received_at::date as rdate
    from public.payments
    where receipt_voucher_no is not null
      and receipt_voucher_no ~ '^RV-\d{4}-\d+$'
  loop
    -- Extract calendar year and sequence number from 'RV-2026-0001'
    v_year   := (regexp_match(r.receipt_voucher_no, '^RV-(\d{4})-'))[1]::int;
    v_number := (regexp_match(r.receipt_voucher_no, '-(\d+)$'))[1]::int;

    -- Infer FY from the receipt date (more accurate than year from ID)
    v_fy := public.indian_fiscal_year(r.rdate);

    -- Seed/update the counter to at least this number
    insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
    values (r.tenant_id, 'receipt_voucher', v_fy, 'RV', v_number)
    on conflict (tenant_id, doc_type, fiscal_year)
    do update set last_number = greatest(document_series.last_number, excluded.last_number);
  end loop;
end $$;

-- ============================================================
-- 8. Admin escape hatch — set sequence start (for tenant onboarding
--    when migrating from an existing accounting system). Only owners
--    can call this via RLS-protected RPC.
-- ============================================================
create or replace function public.set_document_series_start(
  p_doc_type     text,
  p_fiscal_year  text,
  p_start_number integer,
  p_prefix       text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_is_owner  boolean;
  v_prefix    text;
begin
  v_tenant_id := public.current_tenant_id();
  if v_tenant_id is null then
    raise exception 'No tenant context';
  end if;

  -- Only owners may override sequence — financial control gate
  select exists (
    select 1 from public.users
    where id = auth.uid() and tenant_id = v_tenant_id and role = 'owner'
  ) into v_is_owner;

  if not v_is_owner then
    raise exception 'Only tenant owners can modify document sequence';
  end if;

  v_prefix := coalesce(p_prefix, public.default_doc_prefix(p_doc_type));

  insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values (v_tenant_id, p_doc_type, p_fiscal_year, v_prefix, p_start_number)
  on conflict (tenant_id, doc_type, fiscal_year)
  do update set
    last_number = excluded.last_number,
    prefix      = excluded.prefix,
    updated_at  = now();
end;
$$;

grant execute on function public.set_document_series_start(text, text, integer, text) to authenticated;

commit;

-- ============================================================
-- Smoke test (run manually):
--
--   select public.next_document_number('invoice');         -- INV-2025-26-0001
--   select public.next_document_number('invoice');         -- INV-2025-26-0002
--   select public.next_document_number('receipt_voucher'); -- RV-2025-26-NNNN (continues from backfill)
--   select * from public.document_series;
-- ============================================================
