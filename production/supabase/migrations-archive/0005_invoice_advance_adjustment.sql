-- ============================================================
-- ResellerOS — invoice ↔ advance adjustment columns
-- Migration: 0005_invoice_advance_adjustment.sql
-- ============================================================
-- Purpose
--   Indian GST law (CGST Section 31 + Rule 53) requires every Tax Invoice
--   to (a) reference advance Receipt Vouchers received earlier against
--   the same supply, (b) deduct the advance amount, (c) show net payable.
--   Otherwise the customer's ITC claim chain breaks at audit.
--
--   Today the schema's `invoices.amount` is the full quote total — no
--   advance adjustment is recorded. This migration adds:
--
--     adjusted_advances  jsonb   — array of vouchers adjusted (frozen at issue)
--     net_payable        integer — amount - sum(advances)
--     first_advance_at   tstz    — earliest advance receipt → legal supply trigger
--     quote_id           text    — direct FK back to source quote
--
--   These are FROZEN at invoice generation time — later refunds of those
--   advances become credit notes (CGST Section 34), not edits to the
--   original invoice. This preserves the audit chain.
--
-- Also expanded
--   useQuotesAwaitingInvoice (in client code) will now include 'partial'
--   payment_status quotes — supports legally-required 30-day invoicing
--   after first advance, not only after full payment.
-- ============================================================

begin;

-- ============================================================
-- 1. New columns on invoices — additive, safe on existing rows
-- ============================================================
alter table public.invoices
  add column if not exists adjusted_advances jsonb not null default '[]'::jsonb,
  add column if not exists net_payable       integer,
  add column if not exists first_advance_at  timestamptz,
  add column if not exists quote_id          text;

comment on column public.invoices.adjusted_advances is
  'Array of {payment_id, voucher_no, amount, received_at, method} — receipt vouchers adjusted against this invoice. Frozen at issue time; refunds become credit notes.';
comment on column public.invoices.net_payable is
  'Net amount due from customer after adjusting advances. = amount - sum(adjusted_advances[*].amount). Floor 0.';
comment on column public.invoices.first_advance_at is
  'Timestamp of the EARLIEST received payment against the source quote. Drives the 30-day GST invoicing clock (CGST Section 13(2) + Rule 47).';
comment on column public.invoices.quote_id is
  'Source quote ID. One quote can generate multiple invoices in future (split invoicing for long subscriptions). Each invoice references one quote.';

-- FK on quote_id (deferred-safe; on delete set null so historic invoices survive quote deletion)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_quote_id_fkey') then
    alter table public.invoices
      add constraint invoices_quote_id_fkey
      foreign key (quote_id) references public.quotes(id) on delete set null;
  end if;
end $$;

create index if not exists invoices_quote_idx on public.invoices(quote_id) where quote_id is not null;
create index if not exists invoices_first_advance_idx on public.invoices(first_advance_at) where first_advance_at is not null;

-- ============================================================
-- 2. Sanity check — net_payable should never exceed amount
--    (advances can't make net payable negative either)
-- ============================================================
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_net_payable_range') then
    alter table public.invoices
      add constraint invoices_net_payable_range
      check (net_payable is null or (net_payable >= 0 and net_payable <= amount));
  end if;
end $$;

-- ============================================================
-- 3. Backfill — for any existing invoices, compute adjustment data
--    from the payments table. Most prod data is test/empty so this
--    is mostly a no-op but defensive for any real invoices.
-- ============================================================
do $$
declare
  inv record;
  v_advances        jsonb;
  v_advance_total   integer;
  v_first_advance   timestamptz;
  v_quote_id        text;
begin
  for inv in
    select i.id, i.amount, i.tenant_id
    from public.invoices i
  loop
    -- Find the parent quote via reverse FK on quotes.invoice_id
    select q.id into v_quote_id
    from public.quotes q
    where q.invoice_id = inv.id
    limit 1;

    if v_quote_id is null then
      -- Legacy invoice with no quote link — nothing to backfill
      continue;
    end if;

    -- Aggregate received payments for that quote into the jsonb array
    select
      coalesce(jsonb_agg(
        jsonb_build_object(
          'payment_id',  p.id,
          'voucher_no',  p.receipt_voucher_no,
          'amount',      p.amount,
          'received_at', p.received_at,
          'method',      p.method
        ) order by p.received_at
      ), '[]'::jsonb),
      coalesce(sum(p.amount), 0),
      min(p.received_at)
    into v_advances, v_advance_total, v_first_advance
    from public.payments p
    where p.quote_id = v_quote_id
      and p.status = 'received';

    update public.invoices
    set adjusted_advances = v_advances,
        net_payable       = greatest(0, inv.amount - v_advance_total),
        first_advance_at  = v_first_advance,
        quote_id          = v_quote_id
    where id = inv.id;
  end loop;
end $$;

-- ============================================================
-- 4. Helper RPC — fetch advance adjustment data for a quote
--    Used by useGenerateInvoice client to build the jsonb snapshot
--    Returns: {advances: jsonb[], total: int, first_at: tstz}
-- ============================================================
create or replace function public.compute_advance_adjustment(p_quote_id text)
returns table (
  advances     jsonb,
  total_paid   integer,
  first_at     timestamptz
)
language sql
stable
security invoker  -- relies on caller's RLS to access payments
set search_path = public
as $$
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'payment_id',  p.id,
        'voucher_no',  p.receipt_voucher_no,
        'amount',      p.amount,
        'received_at', p.received_at,
        'method',      p.method
      ) order by p.received_at
    ), '[]'::jsonb)       as advances,
    coalesce(sum(p.amount), 0)::integer as total_paid,
    min(p.received_at)    as first_at
  from public.payments p
  where p.quote_id = p_quote_id
    and p.status = 'received';
$$;

grant execute on function public.compute_advance_adjustment(text) to authenticated;

commit;

-- ============================================================
-- Verification:
--
--   select id, amount, net_payable, jsonb_array_length(adjusted_advances) as n_advances
--   from public.invoices order by created_at desc;
--
--   select * from public.compute_advance_adjustment('Q-2026-0042');
-- ============================================================
