-- ============================================================
-- ResellerOS — Customer Portal Auth (Phase 0)
-- Migration: 0016_customer_portal_auth.sql
-- ============================================================
-- customer_users: link table from auth.users → customers
-- current_customer_id(): SQL helper (mirrors current_tenant_id())
-- Additional RLS SELECT policies for customer-side reads
-- ============================================================

begin;

create table public.customer_users (
  id              uuid          primary key default gen_random_uuid(),
  tenant_id       uuid          not null references public.tenants(id)   on delete cascade,
  customer_id     uuid          not null references public.customers(id) on delete cascade,
  auth_user_id    uuid          not null references auth.users(id)       on delete cascade,
  email           text          not null,
  role            text          not null default 'admin',
  last_login_at   timestamptz,
  created_at      timestamptz   not null default now(),
  unique (auth_user_id)
);

create index idx_customer_users_customer on public.customer_users (customer_id);
create index idx_customer_users_email    on public.customer_users (lower(email));
create index idx_customer_users_tenant   on public.customer_users (tenant_id);

alter table public.customer_users enable row level security;

create policy customer_users_select_self
  on public.customer_users for select
  using (auth_user_id = auth.uid());

create policy customer_users_select_own_tenant
  on public.customer_users for select
  using (tenant_id = public.current_tenant_id());

create policy customer_users_insert_service_role
  on public.customer_users for insert
  with check (
    tenant_id = public.current_tenant_id()
    or auth.role() = 'service_role'
  );

create policy customer_users_update_self_or_tenant
  on public.customer_users for update
  using (
    auth_user_id = auth.uid()
    or tenant_id = public.current_tenant_id()
    or auth.role() = 'service_role'
  );

create or replace function public.current_customer_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select customer_id
  from public.customer_users
  where auth_user_id = auth.uid()
  limit 1
$$;

grant execute on function public.current_customer_id() to authenticated;

create policy customers_select_self_customer
  on public.customers for select
  using (id = public.current_customer_id());

create policy quotes_select_own_customer
  on public.quotes for select
  using (customer_id = public.current_customer_id());

create policy invoices_select_own_customer
  on public.invoices for select
  using (customer_id = public.current_customer_id());

create policy payments_select_own_customer
  on public.payments for select
  using (customer_id = public.current_customer_id());

create policy subscriptions_select_own_customer
  on public.subscriptions for select
  using (customer_id = public.current_customer_id());

create policy tenants_select_own_customer
  on public.tenants for select
  using (
    id = (
      select tenant_id from public.customer_users
      where auth_user_id = auth.uid()
      limit 1
    )
  );

commit;
