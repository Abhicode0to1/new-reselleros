-- Company property in an employee's hands (27 Sep 2026).
--
-- A laptop, a phone, a SIM, the office keys, an ID card, a Google Workspace / GitHub /
-- bank-portal login — everything the company hands over the day someone joins and must
-- get back the day they leave. There was no record of any of it: the fixed asset
-- register says what the company OWNS, the payroll says what it PAYS; nothing said who
-- is holding what. At exit that becomes "kya kya diya tha?" from memory.
--
--   employee_assets — one row per item issued; returned_on closes it. A row can point at
--   the fixed asset register (a laptop) or stand alone (a SIM, a login). Kinds are fixed
--   so the offboarding checklist can say "2 devices, 1 SIM, 3 logins still with them".

create table if not exists public.employee_assets (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  employee_id      uuid not null references public.employees(id) on delete cascade,
  kind             text not null check (kind in ('laptop', 'phone', 'sim', 'id_card', 'keys', 'access', 'vehicle', 'document', 'other')),
  name             text not null check (char_length(name) between 1 and 120),
  identifier       text check (identifier is null or char_length(identifier) <= 120),   -- serial / IMEI / number / login
  fixed_asset_id   uuid references public.fixed_assets(id) on delete set null,
  issued_on        date not null default current_date,
  returned_on      date check (returned_on is null or returned_on >= issued_on),
  return_condition text check (return_condition is null or return_condition in ('ok', 'damaged', 'lost', 'revoked')),
  notes            text check (notes is null or char_length(notes) <= 500),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.employee_assets enable row level security;
drop policy if exists "tenant isolation read" on public.employee_assets;
create policy "tenant isolation read" on public.employee_assets
  for select to authenticated using (tenant_id = public.current_tenant_id());
drop policy if exists "tenant isolation write" on public.employee_assets;
create policy "tenant isolation write" on public.employee_assets
  for insert to authenticated with check (tenant_id = public.current_tenant_id());
drop policy if exists "tenant isolation update" on public.employee_assets;
create policy "tenant isolation update" on public.employee_assets
  for update to authenticated using (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());
drop policy if exists "tenant isolation delete" on public.employee_assets;
create policy "tenant isolation delete" on public.employee_assets
  for delete to authenticated using (tenant_id = public.current_tenant_id());
drop policy if exists zzz_service_role_all on public.employee_assets;
create policy zzz_service_role_all on public.employee_assets
  as permissive for all to service_role using (true) with check (true);

create index if not exists employee_assets_employee_idx on public.employee_assets (tenant_id, employee_id, returned_on);
-- One fixed asset can be in one person's hands at a time.
create unique index if not exists employee_assets_fixed_asset_open_uq on public.employee_assets (fixed_asset_id) where returned_on is null and fixed_asset_id is not null;

drop trigger if exists trg_activity_employee_assets on public.employee_assets;
create trigger trg_activity_employee_assets after insert or update or delete on public.employee_assets
  for each row execute function public.log_row_change();
