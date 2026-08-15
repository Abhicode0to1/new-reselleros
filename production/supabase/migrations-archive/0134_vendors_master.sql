-- 0134: Vendors master — a proper supplier list (buy-side mirror of customers).
--
-- Until now a vendor was just a free-text name on each bill, so "Google Cloud"
-- and "Google Cloud India" could drift into duplicates. This adds a vendors
-- table, links bills to it, and backfills existing bills so nothing is lost.

create table if not exists public.vendors (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  name             text not null,
  gstin            text,
  contact_name     text,
  contact_email    text,
  contact_phone    text,
  default_category text,                 -- e.g. COGS-Workspace (prefilled on new bills)
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists vendors_tenant_idx on public.vendors(tenant_id);
-- One vendor per name per tenant (case-insensitive) — kills accidental dupes.
create unique index if not exists vendors_tenant_name_uniq
  on public.vendors (tenant_id, lower(trim(name)));

alter table public.vendors enable row level security;
drop policy if exists "vendors tenant all" on public.vendors;
create policy "vendors tenant all" on public.vendors
  for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- Link bills to the master (nullable — a bill can still carry a raw name).
alter table public.vendor_bills
  add column if not exists vendor_id uuid references public.vendors(id) on delete set null;
create index if not exists vendor_bills_vendor_idx on public.vendor_bills(vendor_id) where vendor_id is not null;

-- ── Backfill: one vendor per distinct bill name, then point bills at it ───────
insert into public.vendors (tenant_id, name, gstin)
select tenant_id, min(trim(vendor_name)) as name, min(vendor_gstin) as gstin
from public.vendor_bills
where coalesce(trim(vendor_name), '') <> ''
group by tenant_id, lower(trim(vendor_name))
on conflict (tenant_id, lower(trim(name))) do nothing;

update public.vendor_bills b
   set vendor_id = v.id
  from public.vendors v
 where v.tenant_id = b.tenant_id
   and lower(trim(v.name)) = lower(trim(b.vendor_name))
   and b.vendor_id is null;
