-- ============================================================
-- ResellerOS — Customer Portal Phase 2: support + auto-renew
-- Migration: 0017_support_tickets_auto_renew.sql
-- ============================================================

begin;

create table public.support_tickets (
  id              text         primary key,
  tenant_id       uuid         not null references public.tenants(id)   on delete cascade,
  customer_id     uuid         references public.customers(id)          on delete set null,
  customer_name   text         not null,
  raised_by_email text         not null,
  raised_by_user  uuid         references auth.users(id) on delete set null,
  category        text         not null,
  priority        text         not null default 'normal',
  subject         text         not null,
  body            text         not null,
  status          text         not null default 'open',
  resolved_at     timestamptz,
  resolved_by     uuid         references auth.users(id) on delete set null,
  resolution_note text,
  created_at      timestamptz  not null default now(),
  updated_at      timestamptz  not null default now()
);

create index idx_support_tickets_tenant_status on public.support_tickets (tenant_id, status);
create index idx_support_tickets_customer     on public.support_tickets (customer_id);
create index idx_support_tickets_priority     on public.support_tickets (tenant_id, priority);

alter table public.support_tickets enable row level security;

create policy support_tickets_select_own_tenant on public.support_tickets for select
  using (tenant_id = public.current_tenant_id());
create policy support_tickets_update_own_tenant on public.support_tickets for update
  using (tenant_id = public.current_tenant_id());
create policy support_tickets_delete_own_tenant on public.support_tickets for delete
  using (tenant_id = public.current_tenant_id());
create policy support_tickets_insert_own_tenant on public.support_tickets for insert
  with check (tenant_id = public.current_tenant_id());
create policy support_tickets_select_own_customer on public.support_tickets for select
  using (customer_id = public.current_customer_id());
create policy support_tickets_insert_own_customer on public.support_tickets for insert
  with check (customer_id = public.current_customer_id());

create trigger trg_support_tickets_updated_at
  before update on public.support_tickets
  for each row execute function public.handle_updated_at();

alter table public.subscriptions
  add column if not exists auto_renew boolean not null default true;

commit;
