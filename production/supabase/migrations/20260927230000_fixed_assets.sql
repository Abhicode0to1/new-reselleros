-- Fixed asset register (27 Sep 2026).
--
-- The Balance Sheet carried assets at COST forever (EMI purchases summed) and had no
-- depreciation at all — a ₹1.2L laptop from 2024 still showed ₹1.2L. This is the
-- register: what was bought, which Income-tax block it falls in, when it was put to
-- use, and (later) when it was sold. Depreciation is computed, never stored
-- (lib/accounting/depreciation.ts — WDV at the block rate, half rate when put to use
-- for under 180 days in the year), so a rate change is one row in code.

create table if not exists public.fixed_assets (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 120),
  block           text not null check (block in ('computers', 'plant', 'furniture', 'vehicles', 'building', 'intangible')),
  cost            integer not null check (cost > 0),
  put_to_use      date not null,
  emi_purchase_id uuid references public.emi_purchases(id) on delete set null,
  expense_id      text references public.expenses(id) on delete set null,
  disposed_on     date check (disposed_on is null or disposed_on >= put_to_use),
  disposal_value  integer not null default 0 check (disposal_value >= 0),
  notes           text check (notes is null or char_length(notes) <= 500),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.fixed_assets enable row level security;
drop policy if exists "tenant isolation read" on public.fixed_assets;
create policy "tenant isolation read" on public.fixed_assets
  for select to authenticated using (tenant_id = public.current_tenant_id());
drop policy if exists "tenant isolation write" on public.fixed_assets;
create policy "tenant isolation write" on public.fixed_assets
  for insert to authenticated with check (tenant_id = public.current_tenant_id());
drop policy if exists "tenant isolation update" on public.fixed_assets;
create policy "tenant isolation update" on public.fixed_assets
  for update to authenticated using (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());
drop policy if exists "tenant isolation delete" on public.fixed_assets;
create policy "tenant isolation delete" on public.fixed_assets
  for delete to authenticated using (tenant_id = public.current_tenant_id());
drop policy if exists zzz_service_role_all on public.fixed_assets;
create policy zzz_service_role_all on public.fixed_assets
  as permissive for all to service_role using (true) with check (true);

create index if not exists fixed_assets_tenant_idx on public.fixed_assets (tenant_id, put_to_use);

-- The audit trail covers it like the other money tables (migration 20260927150000).
drop trigger if exists trg_activity_fixed_assets on public.fixed_assets;
create trigger trg_activity_fixed_assets after insert or update or delete on public.fixed_assets
  for each row execute function public.log_row_change();
