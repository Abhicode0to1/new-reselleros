-- Regression test: sync_hosting_catalog (migration 20260901170000)
--
--   env -u SUPABASE_ACCESS_TOKEN npx supabase db query --linked \
--     -f supabase/tests/sync_hosting_catalog.test.sql
--
-- Self-asserting (RAISEs on failure); whole thing rolls back.
--
-- What it proves:
--   1. Ingesting the DMS hosting plans creates one catalogue item per plan,
--      vendor='hosting', keyed by synced_from_partner_id, with the fractional
--      DMS price rounded to whole rupees (₹49.99 → 50).
--   2. A re-sync is idempotent — same rows, not duplicates — refreshes the
--      price from the engine, but PRESERVES a wholesale (cost) an owner set by
--      hand (the public feed has no cost, so a sync must never wipe it).
--   3. A non-owner cannot sync the catalogue.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code) values
  ('dddddddd-0000-0000-0000-0000000000a1'::uuid, 'HOST SYNC TEST', 'host-a@example.in', '07');

insert into auth.users (id, email) values
  ('dddddddd-0000-0000-0000-0000000000b2', 'owner@example.test');
insert into public.users (id, tenant_id, email, role, is_active) values
  ('dddddddd-0000-0000-0000-0000000000b2'::uuid, 'dddddddd-0000-0000-0000-0000000000a1'::uuid,
   'owner@example.in', 'owner', true);

-- Become that owner (authenticated), so current_tenant_id + current_user_is_owner resolve.
select set_config('request.jwt.claims',
  '{"sub":"dddddddd-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;

-- ── Test 1: first sync creates one hosting item per plan, price rounded ──────
do $$
declare v_n int; v_msrp int; v_vendor text; v_sync text;
begin
  v_n := public.sync_hosting_catalog('[
    {"planId":"starter","name":"Starter","price":49.99,"renewalPrice":49.99,"currency":"INR","period":"/mo","features":["10 GB SSD"],"quotaMB":10000,"bandwidthMB":100000,"popular":false},
    {"planId":"standard","name":"Standard","price":125.00,"renewalPrice":125.00,"currency":"INR","period":"/mo","features":["25 GB SSD"],"quotaMB":25000,"bandwidthMB":200000,"popular":true}
  ]'::jsonb);
  if v_n <> 2 then raise exception 'FAIL 1a: expected 2 plans synced, got %', v_n; end if;

  select count(*) into v_n from public.items
    where tenant_id = 'dddddddd-0000-0000-0000-0000000000a1'::uuid and vendor = 'hosting';
  if v_n <> 2 then raise exception 'FAIL 1b: expected 2 hosting items, got %', v_n; end if;

  select msrp, vendor, synced_from_partner_id into v_msrp, v_vendor, v_sync
    from public.items where synced_from_partner_id = 'starter'
      and tenant_id = 'dddddddd-0000-0000-0000-0000000000a1'::uuid;
  if v_msrp is distinct from 50 then raise exception 'FAIL 1c: ₹49.99 should round to msrp 50, got %', v_msrp; end if;
  if v_vendor is distinct from 'hosting' then raise exception 'FAIL 1d: vendor should be hosting, got %', v_vendor; end if;
  raise notice 'PASS 1: two hosting items created, ₹49.99 rounded to ₹50';
end $$;

-- ── Test 2: re-sync is idempotent, refreshes price, PRESERVES hand-set cost ──
update public.items set wholesale = 30
  where synced_from_partner_id = 'starter' and tenant_id = 'dddddddd-0000-0000-0000-0000000000a1'::uuid;

do $$
declare v_n int; v_msrp int; v_ws int;
begin
  perform public.sync_hosting_catalog('[
    {"planId":"starter","name":"Starter","price":59.00,"renewalPrice":59.00,"currency":"INR","period":"/mo","features":["10 GB SSD"],"quotaMB":10000,"bandwidthMB":100000,"popular":false},
    {"planId":"standard","name":"Standard","price":125.00,"renewalPrice":125.00,"currency":"INR","period":"/mo","features":["25 GB SSD"],"quotaMB":25000,"bandwidthMB":200000,"popular":true}
  ]'::jsonb);

  select count(*) into v_n from public.items
    where tenant_id = 'dddddddd-0000-0000-0000-0000000000a1'::uuid and vendor = 'hosting';
  if v_n <> 2 then raise exception 'FAIL 2a: re-sync should keep 2 items (idempotent), got %', v_n; end if;

  select msrp, wholesale into v_msrp, v_ws from public.items
    where synced_from_partner_id = 'starter' and tenant_id = 'dddddddd-0000-0000-0000-0000000000a1'::uuid;
  if v_msrp is distinct from 59 then raise exception 'FAIL 2b: price should refresh to 59, got %', v_msrp; end if;
  if v_ws is distinct from 30 then raise exception 'FAIL 2c: hand-set wholesale (30) should survive a re-sync, got %', v_ws; end if;
  raise notice 'PASS 2: re-sync idempotent, price refreshed to 59, cost preserved at 30';
end $$;

-- ── Test 3: a non-owner cannot sync ─────────────────────────────────────────
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role postgres;
update public.users set role = 'sales'
  where id = 'dddddddd-0000-0000-0000-0000000000b2'::uuid;
select set_config('request.jwt.claims',
  '{"sub":"dddddddd-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;

do $$
declare ok boolean := false;
begin
  begin
    perform public.sync_hosting_catalog('[{"planId":"starter","name":"S","price":49,"currency":"INR"}]'::jsonb);
  exception when insufficient_privilege then
    ok := true;
  end;
  if not ok then raise exception 'FAIL 3: a non-owner was allowed to sync the catalogue'; end if;
  raise notice 'PASS 3: non-owner sync refused';
end $$;

reset role;
rollback;
