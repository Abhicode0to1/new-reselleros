-- 0041_partner_catalog.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Partner Catalog (Slice 1 — schema + RPC)
--
-- Lets a distributor tenant expose selected SKUs to its sub-reseller children
-- at a partner-specific wholesale price. Child tenants pull the parent's
-- visible items via the get_partner_catalog() RPC and can sync individual
-- rows into their own items table (with the parent's partner_price set as
-- the child's wholesale cost).
--
--   items.is_partner_visible    = true  → distributor exposes this row to children
--                                 false → private (default)
--   items.partner_price         = int   → ₹/seat/MONTH that children pay to the
--                                         distributor. Only meaningful when
--                                         is_partner_visible = true.
--   items.synced_from_partner_id = text → on a child row, the parent's item.id
--                                         it was synced from. Used later for
--                                         "X items have updated pricing — Sync now"
--                                         banners. NULL on rows not synced from
--                                         a partner.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

alter table public.items
  add column if not exists is_partner_visible  boolean not null default false,
  add column if not exists partner_price       integer,
  add column if not exists synced_from_partner_id text;

-- Sanity: partner_price should be non-negative when present.
alter table public.items
  drop constraint if exists items_partner_price_nonneg;
alter table public.items
  add constraint items_partner_price_nonneg
    check (partner_price is null or partner_price >= 0);

-- A partner-visible item must have a partner price set (otherwise the child
-- has nothing to consume). Soft-enforced — many existing rows will sit at
-- is_partner_visible=false, so the check only triggers when the flag is on.
alter table public.items
  drop constraint if exists items_partner_visible_needs_price;
alter table public.items
  add constraint items_partner_visible_needs_price
    check (is_partner_visible = false or partner_price is not null);

create index if not exists idx_items_partner_visible
  on public.items(tenant_id, is_partner_visible)
  where is_partner_visible = true;

create index if not exists idx_items_synced_from_partner
  on public.items(synced_from_partner_id)
  where synced_from_partner_id is not null;

-- ─── RPC: get_partner_catalog() ────────────────────────────────────────────
-- Returns the calling user's parent tenant's partner-visible items. RLS on
-- public.items would otherwise block a cross-tenant read of the parent's
-- catalog, so this function runs SECURITY DEFINER but confines results to
-- the parent of the caller's own tenant — no other tenant's data is
-- reachable through this surface.
create or replace function public.get_partner_catalog()
returns table (
  id              text,
  tenant_id       uuid,
  name            text,
  vendor          text,
  kind            text,
  hsn             text,
  msrp            integer,
  partner_price   integer,
  prices          jsonb,
  is_active       boolean,
  -- child's view: "have I already synced this?" — non-null when the child's
  -- own items table has a row with synced_from_partner_id = this row's id.
  already_synced  boolean
)
language sql
security definer
set search_path = public
stable
as $$
  with me as (
    select u.tenant_id as child_tenant, t.parent_tenant_id as parent_tenant
    from public.users u
    join public.tenants t on t.id = u.tenant_id
    where u.id = auth.uid()
    limit 1
  )
  select
    pi.id,
    pi.tenant_id,
    pi.name,
    pi.vendor::text,
    pi.kind::text,
    pi.hsn,
    pi.msrp,
    pi.partner_price,
    pi.prices,
    pi.is_active,
    exists (
      select 1
      from public.items ci
      where ci.tenant_id = (select child_tenant from me)
        and ci.synced_from_partner_id = pi.id
    ) as already_synced
  from public.items pi
  where pi.tenant_id = (select parent_tenant from me)
    and pi.is_partner_visible = true
    and pi.is_active = true
  order by pi.vendor, pi.kind, pi.name;
$$;

revoke all on function public.get_partner_catalog() from public;
grant  execute on function public.get_partner_catalog() to authenticated;

-- ─── RPC: sync_partner_item(p_partner_item_id, p_my_msrp) ──────────────────
-- Atomically clones a parent's partner-visible item into the child's own
-- items table. Wholesale = parent's partner_price; MSRP = child's chosen
-- retail price (defaults to parent's msrp if not provided). The new child
-- row's id is the parent's id + a short suffix of the child's tenant uuid,
-- matching the convention used elsewhere in the catalog. Idempotent — if
-- already synced, the existing row is updated (wholesale resyncs, MSRP
-- preserved unless the caller passes a new value).
create or replace function public.sync_partner_item(
  p_partner_item_id text,
  p_my_msrp         integer default null
)
returns text  -- the child's new (or updated) item id
language plpgsql
security definer
set search_path = public
as $$
declare
  v_child_tenant uuid;
  v_parent_tenant uuid;
  v_parent items%rowtype;
  v_short text;
  v_new_id text;
  v_existing_id text;
  v_msrp integer;
begin
  -- Resolve caller's tenant + their declared distributor parent
  select u.tenant_id, t.parent_tenant_id
    into v_child_tenant, v_parent_tenant
  from public.users u
  join public.tenants t on t.id = u.tenant_id
  where u.id = auth.uid()
  limit 1;

  if v_parent_tenant is null then
    raise exception 'Your tenant is not linked to a distributor — cannot sync partner items';
  end if;

  -- Fetch the parent item, validating ownership + visibility
  select * into v_parent
  from public.items
  where id = p_partner_item_id
    and tenant_id = v_parent_tenant
    and is_partner_visible = true
    and is_active = true;

  if not found then
    raise exception 'Partner item % not found or not visible to your tenant', p_partner_item_id;
  end if;

  v_msrp := coalesce(p_my_msrp, v_parent.msrp);
  v_short := substr(v_child_tenant::text, 1, 3);
  -- Idempotency: do we already have a synced row?
  select id into v_existing_id
  from public.items
  where tenant_id = v_child_tenant
    and synced_from_partner_id = p_partner_item_id
  limit 1;

  if v_existing_id is not null then
    -- Refresh wholesale + prices from parent; keep child's existing MSRP
    -- unless caller passed a new one explicitly.
    update public.items
      set wholesale = v_parent.partner_price,
          msrp      = case when p_my_msrp is not null then p_my_msrp else msrp end,
          prices    = v_parent.prices,
          is_active = true,
          name      = v_parent.name,
          vendor    = v_parent.vendor,
          kind      = v_parent.kind,
          hsn       = v_parent.hsn
      where id = v_existing_id;
    return v_existing_id;
  end if;

  -- Build new id. Try the natural convention; if it collides (unlikely but
  -- possible with manual data), append a random short suffix.
  v_new_id := regexp_replace(p_partner_item_id, '-[a-f0-9]{2,}$', '') || '-' || v_short;
  -- Ensure uniqueness within child tenant
  if exists (select 1 from public.items where id = v_new_id) then
    v_new_id := v_new_id || '-' || substr(md5(random()::text), 1, 4);
  end if;

  insert into public.items (
    id, tenant_id, name, vendor, kind, hsn,
    msrp, wholesale, prices, is_active,
    synced_from_partner_id, is_partner_visible, partner_price
  ) values (
    v_new_id, v_child_tenant, v_parent.name, v_parent.vendor, v_parent.kind, v_parent.hsn,
    v_msrp, v_parent.partner_price, v_parent.prices, true,
    p_partner_item_id, false, null
  );

  return v_new_id;
end $$;

revoke all on function public.sync_partner_item(text, integer) from public;
grant  execute on function public.sync_partner_item(text, integer) to authenticated;

commit;
