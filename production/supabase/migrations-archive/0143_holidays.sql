-- 0143: company holiday calendar. Payroll's loss-of-pay (LOP) suggestion only
-- treated Sundays as non-working, so an employee absent on a real holiday
-- (Diwali, 15 Aug, …) was counted as a working-day absence and wrongly docked
-- pay. Holidays listed here are excluded from "expected working days" alongside
-- the weekly Sunday off, so LOP — and therefore salary — is correct.

create table if not exists public.holidays (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  holiday_date date not null,
  name         text not null,
  created_at   timestamptz not null default now(),
  unique (tenant_id, holiday_date)
);

alter table public.holidays enable row level security;

create policy holidays_select_own_tenant on public.holidays
  for select using (tenant_id = public.current_tenant_id());
create policy holidays_insert_own_tenant on public.holidays
  for insert with check (tenant_id = public.current_tenant_id());
create policy holidays_delete_own_tenant on public.holidays
  for delete using (tenant_id = public.current_tenant_id());
create policy holidays_service_role_all on public.holidays
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create index if not exists holidays_tenant_date_idx on public.holidays (tenant_id, holiday_date);

grant select, insert, delete on public.holidays to authenticated;
