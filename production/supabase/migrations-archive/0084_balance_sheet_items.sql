-- 0084: balance_sheet_items — operator-entered lines for the Balance Sheet.
--
-- The Balance Sheet auto-computes what ResellerOS tracks (cash & bank,
-- receivables, TDS receivable, payables, GST). But a full/statutory sheet also
-- needs items the app does NOT track: fixed assets + depreciation, loans,
-- owner's capital, drawings, deposits, etc. Those are captured here as manual
-- lines the operator adds under Assets / Liabilities / Equity.
--
-- amount is integer ₹ and MAY be negative — e.g. accumulated depreciation (an
-- asset contra) or owner's drawings (an equity contra).

create table if not exists public.balance_sheet_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  section     text not null check (section in ('asset', 'liability', 'equity')),
  label       text not null,
  amount      integer not null default 0,
  sort_order  integer not null default 0,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists balance_sheet_items_tenant_idx
  on public.balance_sheet_items(tenant_id, section, sort_order);

alter table public.balance_sheet_items enable row level security;

drop policy if exists "tenant isolation read"   on public.balance_sheet_items;
drop policy if exists "tenant isolation write"  on public.balance_sheet_items;
drop policy if exists "tenant isolation update" on public.balance_sheet_items;
drop policy if exists "tenant isolation delete" on public.balance_sheet_items;

create policy "tenant isolation read"   on public.balance_sheet_items for select using  (tenant_id = public.current_tenant_id());
create policy "tenant isolation write"  on public.balance_sheet_items for insert with check (tenant_id = public.current_tenant_id());
create policy "tenant isolation update" on public.balance_sheet_items for update using  (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());
create policy "tenant isolation delete" on public.balance_sheet_items for delete using  (tenant_id = public.current_tenant_id());
