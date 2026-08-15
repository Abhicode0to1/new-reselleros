-- 0071_customers_customer_number.sql
--
-- External reference / "Customer Number" (e.g. Zoho "CUS-00001") on customers,
-- so a migration can match imported subscriptions to their customer by a stable,
-- human-meaningful key instead of email (many migrated rows have no/duplicate
-- email). Tenant-scoped index for fast lookup during the subscription import.
--
-- Inherits the existing customers RLS (tenant-scoped). Plain text — no format
-- enforced (the value comes from the source system verbatim).

alter table public.customers
  add column if not exists customer_number text;

create index if not exists idx_customers_tenant_customer_number
  on public.customers (tenant_id, customer_number);

comment on column public.customers.customer_number is
  'External reference from the source system (e.g. Zoho "CUS-00001"). Used as the join key when importing subscriptions.';
