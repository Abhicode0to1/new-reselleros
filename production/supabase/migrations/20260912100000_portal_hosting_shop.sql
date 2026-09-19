-- Hosting in the customer portal's shop.
--
-- Pardeep, 12 Sep 2026: "Put hosting in the portal shop, so a logged-in customer
-- can buy without going back to the marketing site."
--
-- ─── WHY A SECOND RPC AND NOT A WIDER portal_list_products() ────────────────
-- A portal customer sits in `customer_users`, not `users`, so operator RLS gives
-- them NOTHING on `items` — the shop has to read through a SECURITY DEFINER
-- function. `portal_list_products()` is that function for seat licences, and it
-- returns exactly five columns shaped around a per-SEAT sale
-- (`price_per_seat_month`). Hosting is not sold per seat: it is one account on
-- one domain, and what a buyer needs to compare is disk, bandwidth and what the
-- plan includes. Widening the existing function's return type would change a
-- signature three call sites already depend on, to carry columns that mean
-- nothing for a Google Workspace licence.
--
-- ─── AND WHY THE CATALOGUE, NOT THE MARKETING PRICE LIST ────────────────────
-- The obvious shortcut was `HOSTING_TIERS` in site/lib/data/hosting-landing-v2,
-- which is what /api/public/checkout/cart re-prices against. That list is
-- Anutech Digital's OWN retail pricing. The marketing site only ever sells for
-- one tenant (BUY_PAGE_TENANT_ID), so a constant is honest there — but the
-- portal serves every reseller's customers, and pricing them all off Anutech's
-- card would have each reseller selling at a competitor's number. `items` is
-- already per-tenant and already the source `sync_hosting_catalog` refreshes
-- from the DMS engine, so it is the only correct source here.
--
-- ─── WHAT A CUSTOMER MAY SEE ────────────────────────────────────────────────
-- `items` carries reseller-only economics — `wholesale`, `margin_pct`,
-- `partner_price`. None of them appear below. This returns the sell price and
-- the specs a buyer compares, and nothing else, which is the same bar
-- portal_list_products() sets.

-- ── 1. The hosting plans a customer may browse ─────────────────────────────
-- Whole rupees (§13). `prices` is the jsonb sync_hosting_catalog writes; the
-- specs live there and are absent on hand-made rows, so every read is coalesced
-- to a usable default rather than returning null into a price card.
create or replace function public.portal_list_hosting_plans()
returns table (
  id           text,
  name         text,
  price_month  int,
  period       text,
  hsn          text,
  quota_mb     int,
  bandwidth_mb int,
  features     jsonb,
  popular      boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    i.id,
    i.name,
    i.msrp                                                as price_month,
    coalesce(nullif(i.prices->>'period', ''), '/mo')      as period,
    i.hsn,
    nullif(i.prices->>'quotaMB', '')::int                 as quota_mb,
    nullif(i.prices->>'bandwidthMB', '')::int             as bandwidth_mb,
    coalesce(i.prices->'features', '[]'::jsonb)           as features,
    coalesce((i.prices->>'popular')::boolean, false)      as popular
  from public.items i
  where i.is_active = true
    and i.kind   = 'main'
    and i.vendor = 'hosting'
    and i.tenant_id = (
      select cu.tenant_id from public.customer_users cu
      where cu.auth_user_id = auth.uid()
      limit 1
    )
  order by i.msrp asc, i.name asc;
$$;

grant execute on function public.portal_list_hosting_plans() to authenticated;

-- ── 2. Hosting leaves the seat catalogue ───────────────────────────────────
-- Unchanged apart from the vendor filter. `sync_hosting_catalog` writes hosting
-- with kind='main', so without this every synced plan ALSO appears in the seat
-- grid — under "More products", priced "₹499/user/month" with a seats box, for a
-- product that has no seats. One product, listed twice, with one of the two
-- listings wrong about how it is sold.
--
-- NOTE for whoever reads this next: `vendor='domain'` rows have the same
-- problem and are still listed as per-seat products. Left alone deliberately —
-- domains need their own buying flow (a name to search, not a quantity), and
-- silently hiding them would remove a surface before its replacement exists.
create or replace function public.portal_list_products()
returns table (
  id                   text,
  name                 text,
  vendor               text,
  price_per_seat_month int,
  hsn                  text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    i.id,
    i.name,
    i.vendor::text,
    coalesce(
      nullif((i.prices->'annual'->>'msrp'), '')::int,
      i.msrp
    ) as price_per_seat_month,
    i.hsn
  from public.items i
  where i.is_active = true
    and i.kind = 'main'
    and i.vendor <> 'hosting'
    and i.tenant_id = (
      select cu.tenant_id from public.customer_users cu
      where cu.auth_user_id = auth.uid()
      limit 1
    )
  order by coalesce(nullif((i.prices->'annual'->>'msrp'),'')::int, i.msrp) asc, i.name asc;
$$;

grant execute on function public.portal_list_products() to authenticated;
grant execute on function public.portal_list_products() to anon;
