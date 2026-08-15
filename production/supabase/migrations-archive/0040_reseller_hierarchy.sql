-- 0040_reseller_hierarchy.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Parent-child reseller hierarchy (Slice 0 — schema only)
--
-- Lets one tenant declare itself a "distributor" with other tenants as
-- children ("resellers"). Two columns + supporting view. Both columns are
-- nullable / safely defaulted so existing peer-to-peer tenants keep working
-- with zero behaviour change.
--
--   tier              = 'distributor'  → can have children (e.g. Excel Tech)
--                     = 'reseller'     → can have a parent (default)
--   parent_tenant_id  = uuid           → this tenant buys wholesale from
--                                        the referenced distributor tenant
--                     = NULL           → independent peer (current default)
--
-- Unlocks (in later slices):
--   • Partner Catalog (child sees parent's SKUs)
--   • Auto vendor-bill mirroring on cross-tenant invoices
--   • Distributor's /partners aggregated revenue view
--   • Renewal sync between parent + child
--   • CSP provisioning forward from child to parent
-- ─────────────────────────────────────────────────────────────────────────────

begin;

alter table public.tenants
  add column if not exists parent_tenant_id uuid
    references public.tenants(id) on delete set null,
  add column if not exists tier text not null default 'reseller'
    check (tier in ('distributor', 'reseller'));

-- A tenant cannot be its own parent.
alter table public.tenants
  drop constraint if exists tenants_no_self_parent;
alter table public.tenants
  add constraint tenants_no_self_parent
    check (parent_tenant_id is null or parent_tenant_id <> id);

-- A child tenant can only point to a distributor (enforced at app layer in
-- writes — DB-level cross-row check would require a trigger, not worth it for
-- a setting that's owner-only). Indices for cheap parent/tier lookups.
create index if not exists idx_tenants_parent_tenant_id
  on public.tenants(parent_tenant_id);
create index if not exists idx_tenants_tier
  on public.tenants(tier);

-- Helper view to fetch a tenant alongside its parent's display fields.
-- Used by Settings → Company "Reseller Tier" card.
create or replace view public.v_tenant_with_parent as
select
  t.id,
  t.name,
  t.tier,
  t.parent_tenant_id,
  p.name  as parent_name,
  p.tier  as parent_tier,
  p.gstin as parent_gstin
from public.tenants t
left join public.tenants p on p.id = t.parent_tenant_id;

-- The view inherits RLS from the underlying tenants table, so the LEFT JOIN
-- to the parent row gets blocked for non-owners of that parent — even though
-- we only want to read display fields (name / tier / gstin).
--
-- Tried adding an additive policy that referenced `tenants` from inside the
-- USING clause and hit infinite recursion (policy on tenants queries tenants
-- which re-triggers the policy). The safer pattern is a SECURITY DEFINER
-- RPC that runs as the function owner (bypassing RLS for the JOIN) but
-- confines the result to the caller's own tenant via a WHERE clause.
create or replace function public.get_my_tenant_with_parent()
returns table (
  id                uuid,
  name              text,
  tier              text,
  parent_tenant_id  uuid,
  parent_name       text,
  parent_tier       text,
  parent_gstin      text
)
language sql
security definer
set search_path = public
stable
as $$
  with my as (
    select tenant_id from public.users where id = auth.uid() limit 1
  )
  select
    t.id, t.name, t.tier, t.parent_tenant_id,
    p.name, p.tier, p.gstin
  from public.tenants t
  left join public.tenants p on p.id = t.parent_tenant_id
  where t.id = (select tenant_id from my);
$$;

revoke all on function public.get_my_tenant_with_parent() from public;
grant  execute on function public.get_my_tenant_with_parent() to authenticated;

commit;
