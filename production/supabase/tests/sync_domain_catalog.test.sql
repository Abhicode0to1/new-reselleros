-- Regression test: sync_domain_catalog (migration 20260902090000)
--
--   env -u SUPABASE_ACCESS_TOKEN npx supabase db query --linked \
--     -f supabase/tests/sync_domain_catalog.test.sql
--
-- Self-asserting (RAISEs on failure); whole thing rolls back.
--
-- What it proves:
--   1. Ingesting the tld-pricing rows creates one ONE-TIME catalogue item per
--      priced TLD (vendor='domain', item_type='one_time', keyed by tld), msrp =
--      the register price. A TLD with no price is SKIPPED — never a ₹0 domain.
--   2. Re-sync is idempotent, refreshes the register price, and PRESERVES a
--      wholesale (cost) set by hand.
--   3. A non-owner cannot sync.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code) values
  ('eeeeeeee-0000-0000-0000-0000000000a1'::uuid, 'DOMAIN SYNC TEST', 'dom-a@example.in', '07');
insert into auth.users (id, email) values
  ('eeeeeeee-0000-0000-0000-0000000000b2', 'dom-owner@example.test');
insert into public.users (id, tenant_id, email, role, is_active) values
  ('eeeeeeee-0000-0000-0000-0000000000b2'::uuid, 'eeeeeeee-0000-0000-0000-0000000000a1'::uuid,
   'dom-owner@example.in', 'owner', true);

select set_config('request.jwt.claims',
  '{"sub":"eeeeeeee-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;

-- ── Test 1: two priced TLDs become items; the unpriced one is skipped ────────
do $$
declare v_n int; v_msrp int; v_type text; v_vendor text;
begin
  v_n := public.sync_domain_catalog('[
    {"tld":".in","register":799,"renew":899,"transfer":799,"currency":"INR"},
    {"tld":".com","register":949,"renew":1099,"transfer":949,"currency":"INR"},
    {"tld":".xyz","register":null,"renew":null,"transfer":null,"currency":"INR"}
  ]'::jsonb);
  if v_n <> 2 then raise exception 'FAIL 1a: expected 2 priced TLDs synced (xyz skipped), got %', v_n; end if;

  select count(*) into v_n from public.items
    where tenant_id = 'eeeeeeee-0000-0000-0000-0000000000a1'::uuid and vendor = 'domain';
  if v_n <> 2 then raise exception 'FAIL 1b: expected 2 domain items, got %', v_n; end if;

  select msrp, item_type, vendor into v_msrp, v_type, v_vendor from public.items
    where synced_from_partner_id = '.in' and tenant_id = 'eeeeeeee-0000-0000-0000-0000000000a1'::uuid;
  if v_msrp is distinct from 799 then raise exception 'FAIL 1c: .in msrp should be 799, got %', v_msrp; end if;
  if v_type is distinct from 'one_time' then raise exception 'FAIL 1d: domain should be one_time, got %', v_type; end if;
  if v_vendor is distinct from 'domain' then raise exception 'FAIL 1e: vendor should be domain, got %', v_vendor; end if;

  perform 1 from public.items where synced_from_partner_id = '.xyz'
    and tenant_id = 'eeeeeeee-0000-0000-0000-0000000000a1'::uuid;
  if found then raise exception 'FAIL 1f: the unpriced .xyz TLD should NOT have been created'; end if;
  raise notice 'PASS 1: two priced domain items created (one_time), unpriced TLD skipped';
end $$;

-- ── Test 2: re-sync idempotent, refreshes price, preserves hand-set cost ─────
update public.items set wholesale = 500
  where synced_from_partner_id = '.in' and tenant_id = 'eeeeeeee-0000-0000-0000-0000000000a1'::uuid;

do $$
declare v_n int; v_msrp int; v_ws int;
begin
  perform public.sync_domain_catalog('[
    {"tld":".in","register":849,"renew":899,"transfer":799,"currency":"INR"},
    {"tld":".com","register":949,"renew":1099,"transfer":949,"currency":"INR"}
  ]'::jsonb);

  select count(*) into v_n from public.items
    where tenant_id = 'eeeeeeee-0000-0000-0000-0000000000a1'::uuid and vendor = 'domain';
  if v_n <> 2 then raise exception 'FAIL 2a: re-sync should keep 2 items, got %', v_n; end if;

  select msrp, wholesale into v_msrp, v_ws from public.items
    where synced_from_partner_id = '.in' and tenant_id = 'eeeeeeee-0000-0000-0000-0000000000a1'::uuid;
  if v_msrp is distinct from 849 then raise exception 'FAIL 2b: .in price should refresh to 849, got %', v_msrp; end if;
  if v_ws is distinct from 500 then raise exception 'FAIL 2c: hand-set wholesale (500) should survive, got %', v_ws; end if;
  raise notice 'PASS 2: re-sync idempotent, price refreshed, cost preserved';
end $$;

-- ── Test 3: a non-owner cannot sync ─────────────────────────────────────────
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role postgres;
update public.users set role = 'sales'
  where id = 'eeeeeeee-0000-0000-0000-0000000000b2'::uuid;
select set_config('request.jwt.claims',
  '{"sub":"eeeeeeee-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;

do $$
declare ok boolean := false;
begin
  begin
    perform public.sync_domain_catalog('[{"tld":".in","register":799,"currency":"INR"}]'::jsonb);
  exception when insufficient_privilege then
    ok := true;
  end;
  if not ok then raise exception 'FAIL 3: a non-owner was allowed to sync the catalogue'; end if;
  raise notice 'PASS 3: non-owner sync refused';
end $$;

reset role;
rollback;
