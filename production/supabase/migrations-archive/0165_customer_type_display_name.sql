-- ============================================================================
-- 0165 — Customer type (Business / Individual) + display name (Pardeep, Aug 2026)
--
-- Zoho-parity, both additive + safe:
--   customer_type text  — 'business' (default) or 'individual'. Many reseller
--       customers are individuals (no company). For an individual the person IS
--       the customer, so `name` holds their name and there's no company.
--   display_name  text  — optional friendly label shown in the UI (lists,
--       customer header). NULL → fall back to `name`. The GST invoice always
--       uses the legal `name`, never this — so this can't affect tax documents.
--
-- `name` semantics are unchanged for existing (business) customers: it stays the
-- company / legal name that already appears on invoices. Nothing to backfill.
-- ============================================================================

alter table customers
  add column if not exists customer_type text not null default 'business',
  add column if not exists display_name  text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'customers_customer_type_chk') then
    alter table customers
      add constraint customers_customer_type_chk
      check (customer_type in ('business', 'individual'));
  end if;
end $$;
