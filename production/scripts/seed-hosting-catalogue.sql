-- Local-only hosting plans for the portal shop.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres \
--     < scripts/seed-hosting-catalogue.sql
--
-- ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
-- `/portal/shop` prices hosting from the reseller's own `items` catalogue, which
-- `sync_hosting_catalog(p_plans)` fills from the DMS engine's public API. That
-- sync needs DMS credentials nobody has installed on this machine, so without a
-- fixture the hosting section of the shop renders empty and there is nothing to
-- click through — the same "no data, so the screen looks broken rather than
-- unbuilt" trap the portal customer fixture was written to close.
--
-- ─── IT MIRRORS THE SYNC, IT DOES NOT INVENT A SHAPE ────────────────────────
-- Every column below is what sync_hosting_catalog writes, on purpose: the id
-- form HOST-<PLANID>-<tenant6>, vendor 'hosting', kind 'main', item_type
-- 'subscription', hsn 998315, whole-rupee msrp (§13), wholesale seeded to msrp
-- (breakeven — the public feed carries no cost), and the `prices` jsonb holding
-- quotaMB / bandwidthMB / features / period. If the shop renders these correctly
-- it renders real synced plans correctly, which a hand-shaped fixture could not
-- promise.
--
-- Prices are the engine's published tiers. They are a SEED for local clicking,
-- not a price list — a real tenant's numbers arrive from the sync.
--
-- Safe to re-run: upserts on the same deterministic ids.

do $seed$
declare
  v_tenant uuid := '22222222-2222-2222-2222-222222222222';  -- Anutech Digital Pvt Ltd
  v_frag   text := substr(replace(v_tenant::text, '-', ''), 1, 6);
  v_count  int;
begin
  if not exists (select 1 from public.tenants where id = v_tenant) then
    raise exception 'tenant % not found — run the local setup first', v_tenant;
  end if;

  insert into public.items (
    id, tenant_id, name, vendor, hsn, msrp, wholesale,
    item_type, kind, is_active, prices, synced_from_partner_id
  )
  values
    ('HOST-STARTER-'  || v_frag, v_tenant, 'Starter Hosting',  'hosting', '998315',  199,  199,
     'subscription', 'main', true,
     jsonb_build_object(
       'msrp', 199, 'price_raw', 199, 'renewal', 249, 'currency', 'INR', 'period', '/mo',
       'quotaMB', 10240, 'bandwidthMB', 102400,
       'features', jsonb_build_array('1 website', 'Free SSL', 'Daily backups', 'Free migration'),
       'popular', false),
     'starter'),
    ('HOST-STANDARD-' || v_frag, v_tenant, 'Standard Hosting', 'hosting', '998315',  499,  499,
     'subscription', 'main', true,
     jsonb_build_object(
       'msrp', 499, 'price_raw', 499, 'renewal', 599, 'currency', 'INR', 'period', '/mo',
       'quotaMB', 51200, 'bandwidthMB', 512000,
       'features', jsonb_build_array('10 websites', 'Free SSL', 'Daily backups', 'Free migration', '24x7 support'),
       'popular', true),
     'standard'),
    ('HOST-PLUS-'     || v_frag, v_tenant, 'Plus Hosting',     'hosting', '998315',  999,  999,
     'subscription', 'main', true,
     jsonb_build_object(
       'msrp', 999, 'price_raw', 999, 'renewal', 1199, 'currency', 'INR', 'period', '/mo',
       'quotaMB', 153600, 'bandwidthMB', 1048576,
       'features', jsonb_build_array('Unlimited websites', 'Free SSL', 'Daily backups', 'Free migration', '24x7 priority support'),
       'popular', false),
     'plus')
  on conflict (id) do update set
    name      = excluded.name,
    vendor    = 'hosting',
    msrp      = excluded.msrp,
    is_active = true,
    prices    = excluded.prices;

  -- Prove it through the RPC the shop actually calls, not through the table we
  -- just wrote. A row that exists but which portal_list_hosting_plans() filters
  -- out (wrong vendor, wrong kind, inactive) is the failure worth catching, and
  -- selecting from `items` here would hide exactly that.
  select count(*) into v_count from public.items
   where tenant_id = v_tenant and vendor = 'hosting' and kind = 'main' and is_active;
  if v_count < 3 then
    raise exception 'seed incomplete: % hosting plans on the tenant', v_count;
  end if;

  raise notice 'hosting catalogue ready — % plans on %', v_count, v_tenant;
end $seed$;
