-- 0168_customer_groups.sql
-- ============================================================
-- Customer Groups / Parent Accounts.
--
-- Real-world case (Pardeep): one person / reseller (X) routes work for SEVERAL
-- distinct companies, and each company needs its OWN invoice in its OWN legal name
-- + GSTIN. GST law forbids billing multiple legal entities on one tax invoice, so
-- each company MUST stay its own `customers` row (own name/GSTIN/state → own
-- invoices → own payments). This migration adds a lightweight umbrella that links
-- those separate customer rows under the common person/reseller X, purely as a
-- RELATIONSHIP + REPORTING layer:
--   • see all of X's companies in one place
--   • roll up total outstanding / MRR across the group
--   • a shared point-of-contact
-- It is NOT a billing entity — nothing here changes invoicing. When X also takes a
-- commission, `is_partner` flags that and the existing referral_partners system
-- handles the per-deal commission (kept separate on purpose).
--
-- Shape: 1 group → many customers (customers.group_id). A company belongs to at
-- most one umbrella. on delete set null → deleting a group just un-links its
-- companies, never deletes a customer or its money history.
-- ============================================================

create table if not exists public.customer_groups (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  name          text not null,                 -- the reseller/coordinator or umbrella name (X)
  contact_name  text,                          -- shared point-of-contact across the companies
  contact_email text,
  contact_phone text,
  is_partner    boolean not null default false, -- X also earns a commission → see referral_partners
  notes         text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid
);

comment on table public.customer_groups is
  'Umbrella / parent account linking multiple customer companies routed by one common reseller/coordinator (X). Relationship + reporting layer only — billing stays per-customer (each company keeps its own GSTIN + invoices).';

alter table public.customer_groups enable row level security;

create policy customer_groups_select_own_tenant on public.customer_groups
  for select using (tenant_id = public.current_tenant_id());
create policy customer_groups_insert_own_tenant on public.customer_groups
  for insert with check (tenant_id = public.current_tenant_id());
create policy customer_groups_update_own_tenant on public.customer_groups
  for update using (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());
create policy customer_groups_delete_own_tenant on public.customer_groups
  for delete using (tenant_id = public.current_tenant_id());
create policy customer_groups_service_role_all on public.customer_groups
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- Link customers to a group (nullable — most customers have no umbrella).
alter table public.customers
  add column if not exists group_id uuid references public.customer_groups(id) on delete set null;

comment on column public.customers.group_id is
  'Optional parent account (customer_groups). Groups companies routed by one common reseller/coordinator. Does not affect this customer''s own invoicing/GSTIN.';

create index if not exists customers_group_idx on public.customers (tenant_id, group_id) where group_id is not null;

-- keep updated_at fresh
create or replace function public.touch_customer_groups_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists trg_customer_groups_touch on public.customer_groups;
create trigger trg_customer_groups_touch
  before update on public.customer_groups
  for each row execute function public.touch_customer_groups_updated_at();
