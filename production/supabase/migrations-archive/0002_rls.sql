-- ============================================================
-- ResellerOS — Row-Level Security policies
-- Migration: 0002_rls.sql
-- ============================================================
-- CRITICAL: Every domain table is tenant-isolated.
-- The user can only see/modify rows where tenant_id = current_tenant_id().
-- ============================================================

-- ============================================================
-- tenants — users can read their own tenant only
-- ============================================================
alter table public.tenants enable row level security;

create policy "tenants_self_read"
  on public.tenants for select
  to authenticated
  using (id = public.current_tenant_id());

create policy "tenants_self_update"
  on public.tenants for update
  to authenticated
  using (
    id = public.current_tenant_id()
    and exists (select 1 from public.users where id = auth.uid() and role = 'owner')
  );

-- Tenant creation happens via signup flow (handled by service role)

-- ============================================================
-- users — see all teammates in your tenant
-- ============================================================
alter table public.users enable row level security;

create policy "users_tenant_read"
  on public.users for select
  to authenticated
  using (tenant_id = public.current_tenant_id());

create policy "users_self_update"
  on public.users for update
  to authenticated
  using (id = auth.uid());

create policy "users_owner_manage"
  on public.users for all
  to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner')
  );

-- ============================================================
-- Macro: create a standard "tenant_id matches" policy on a table
-- ============================================================
-- We can't truly templatize in PG without dynamic SQL, so each table gets explicit policies.
-- Same shape: SELECT/INSERT/UPDATE/DELETE all check tenant_id = current_tenant_id().

-- ============================================================
-- customers
-- ============================================================
alter table public.customers enable row level security;

create policy "customers_select" on public.customers for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy "customers_insert" on public.customers for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy "customers_update" on public.customers for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy "customers_delete" on public.customers for delete to authenticated
  using (tenant_id = public.current_tenant_id());

-- ============================================================
-- items
-- ============================================================
alter table public.items enable row level security;

create policy "items_select" on public.items for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy "items_insert" on public.items for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy "items_update" on public.items for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy "items_delete" on public.items for delete to authenticated
  using (tenant_id = public.current_tenant_id());

-- ============================================================
-- leads
-- ============================================================
alter table public.leads enable row level security;

create policy "leads_select" on public.leads for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy "leads_insert" on public.leads for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy "leads_update" on public.leads for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy "leads_delete" on public.leads for delete to authenticated
  using (tenant_id = public.current_tenant_id());

-- ============================================================
-- quotes
-- ============================================================
alter table public.quotes enable row level security;

create policy "quotes_select" on public.quotes for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy "quotes_insert" on public.quotes for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy "quotes_update" on public.quotes for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy "quotes_delete" on public.quotes for delete to authenticated
  using (tenant_id = public.current_tenant_id());

-- ============================================================
-- invoices
-- ============================================================
alter table public.invoices enable row level security;

create policy "invoices_select" on public.invoices for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy "invoices_insert" on public.invoices for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy "invoices_update" on public.invoices for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- No DELETE policy — invoices should be voided, not deleted (legal records)

-- ============================================================
-- subscriptions
-- ============================================================
alter table public.subscriptions enable row level security;

create policy "subs_select" on public.subscriptions for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy "subs_insert" on public.subscriptions for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy "subs_update" on public.subscriptions for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy "subs_delete" on public.subscriptions for delete to authenticated
  using (tenant_id = public.current_tenant_id());

-- ============================================================
-- Sign-up trigger: when an auth.user is created, also create a public.user
-- (the tenant_id needs to be set by the signup flow itself —
--  the trigger just stubs the row, signup flow updates it)
-- ============================================================
-- We handle this in the application-level signup flow instead to give us
-- control over tenant creation. See app/(auth)/signup/page.tsx.
