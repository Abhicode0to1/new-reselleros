-- 0054: tenant-scoped document IDs — fix cross-tenant global-PK collisions
--
-- Problem (confirmed live): quotes.id / invoices.id / purchase_orders.id are GLOBAL
-- text primary keys, but next_document_number() numbers them PER-TENANT. So two
-- tenants both generate e.g. Q-2026-27-0009 and collide on the global PK — breaking
-- quote/PO/invoice auto-creation for the second tenant. 9 FKs reference these ids, so
-- a composite PK is too invasive. Instead we make the IDs globally unique by inserting
-- a per-tenant code: {PREFIX}-{CODE}-{FY}-{NNNN}, e.g. INV-ET-2026-27-0001.
--
-- - No PK/FK change (still single text id). Existing ids are untouched (only NEW ids
--   get the code). The per-tenant sequence number is unchanged (no gaps).
-- - GST note: a consistent per-tenant prefix in the invoice series is acceptable
--   (CGST Rule 46 needs a consistent, gap-free series per supplier — the code is part
--   of the consistent series going forward).

-- 1. Per-tenant document code
alter table public.tenants add column if not exists doc_code text;

comment on column public.tenants.doc_code is
  'Short per-tenant code embedded in document numbers (e.g. ET) to keep global doc ids unique across tenants. Shown on GST invoices.';

-- 2. Backfill: confirmed codes for the two real tenants, derived fallback for the rest
update public.tenants set doc_code = 'ET'  where id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
update public.tenants set doc_code = 'ANU' where id = '8ff50dbf-e17e-4210-a580-0df7b1a6f71b';
update public.tenants
   set doc_code = coalesce(
         nullif(upper(substring(regexp_replace(coalesce(name,''), '[^A-Za-z0-9]', '', 'g') from 1 for 4)), ''),
         upper(substring(replace(id::text, '-', '') from 1 for 4))
       )
 where doc_code is null or trim(doc_code) = '';

-- 3. next_document_number — embed the tenant code (everything else unchanged)
create or replace function public.next_document_number(
  p_doc_type  text,
  p_tenant_id uuid default null
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
  v_code        text;
  v_next_number integer;
begin
  v_tenant_id := coalesce(p_tenant_id, public.current_tenant_id());
  if v_tenant_id is null then
    raise exception 'No tenant context — next_document_number requires authenticated session or explicit tenant_id';
  end if;

  if p_doc_type not in ('invoice','receipt_voucher','refund_voucher','credit_note','debit_note','quote','purchase_order','campaign') then
    raise exception 'Invalid doc_type: %', p_doc_type;
  end if;

  v_fy     := public.indian_fiscal_year();
  v_prefix := public.default_doc_prefix(p_doc_type);

  -- Per-tenant code makes the resulting id globally unique. Fallback to a tenant-id
  -- segment if a code was somehow never set (never null in practice after backfill).
  select doc_code into v_code from public.tenants where id = v_tenant_id;
  v_code := coalesce(nullif(trim(v_code), ''), upper(substring(replace(v_tenant_id::text, '-', '') from 1 for 4)));

  insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values (v_tenant_id, p_doc_type, v_fy, v_prefix, 1)
  on conflict (tenant_id, doc_type, fiscal_year)
  do update set
    last_number = document_series.last_number + 1,
    updated_at  = now()
  returning last_number into v_next_number;

  -- {PREFIX}-{CODE}-{FY}-{NNNN}  e.g.  INV-ET-2026-27-0001
  return public.format_document_number(v_prefix || '-' || v_code, v_fy, v_next_number);
end;
$$;

grant execute on function public.next_document_number(text, uuid) to authenticated, service_role;
