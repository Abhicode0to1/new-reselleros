-- Regression test: portal customer can toggle ONLY their own subscription's
-- auto-renew (migration 0062). Run on a dev/test DB. Self-asserting; rolled back.
--
-- Proves:
--   1. A logged-in customer toggles their own sub → auto_renew flips, seats/mrr
--      untouched, RPC returns the new value.
--   2. The same customer cannot toggle ANOTHER customer's sub → RPC raises and
--      that sub is unchanged (no cross-customer write).
--
-- NOTE: customer_users.auth_user_id FKs to auth.users, so this test needs an auth
-- user. It used to BORROW one — `select id from auth.users limit 1` — and that broke
-- on 11 Sep 2026 with:
--
--   duplicate key value violates unique constraint "customer_users_auth_user_id_key"
--
-- `customer_users.auth_user_id` is UNIQUE, and `limit 1` with no `order by` and no
-- filter will happily pick an auth user who is ALREADY a portal customer. That is not
-- a rare edge: it happened as soon as somebody signed into the portal on this
-- database, because that sign-in creates exactly such a row. So the test's own
-- fixture was in a race with real usage, and which row `limit 1` returns is not even
-- defined.
--
-- It now creates its own auth user, the way `portal_customer_users_no_self_update`
-- already did. Rolled back with everything else, and it cannot collide with anybody.

begin;
-- ── setup (service_role) ──
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('ffffffff-0000-0000-0000-0000000000f1','PORTAL T','pt@example.in','07','PRT1');
insert into public.customers (id, tenant_id, name, contact_email)
  values ('cccccccc-0000-0000-0000-0000000000f1','ffffffff-0000-0000-0000-0000000000f1','Cust A','a@portal.in'),
         ('cccccccc-0000-0000-0000-0000000000f2','ffffffff-0000-0000-0000-0000000000f1','Cust B','b@portal.in');
-- This test's OWN auth user — not somebody else's. Both rows roll back.
insert into auth.users (id, email)
  values ('ffffffff-0000-0000-0000-0000000000f9', 'portal-auto-renew@example.test');
insert into public.customer_users (auth_user_id, customer_id, tenant_id, email, role)
  values ('ffffffff-0000-0000-0000-0000000000f9','cccccccc-0000-0000-0000-0000000000f1','ffffffff-0000-0000-0000-0000000000f1','a@portal.in','admin');
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, start_date, renewal_date, auto_renew)
  values ('aaaaaaaa-0000-0000-0000-0000000000f1','ffffffff-0000-0000-0000-0000000000f1','cccccccc-0000-0000-0000-0000000000f1','Cust A','Google Workspace Standard','google',10,8640,'active',current_date,current_date+365,true),
         ('aaaaaaaa-0000-0000-0000-0000000000f2','ffffffff-0000-0000-0000-0000000000f1','cccccccc-0000-0000-0000-0000000000f2','Cust B','Google Workspace Standard','google',5,4320,'active',current_date,current_date+365,true);

-- ── act as customer A (authenticated) ──
do $$
declare v_uid text; v_ret boolean; v_ar boolean; v_seats int; v_mrr int; v_b_ar boolean; v_err boolean := false;
begin
  select auth_user_id::text into v_uid from public.customer_users where customer_id='cccccccc-0000-0000-0000-0000000000f1';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role','authenticated')::text, true);

  v_ret := public.set_subscription_auto_renew('aaaaaaaa-0000-0000-0000-0000000000f1', false);
  if v_ret <> false then raise exception 'FAIL: return expected false, got %', v_ret; end if;
  select auto_renew, seats, mrr into v_ar, v_seats, v_mrr from public.subscriptions where id='aaaaaaaa-0000-0000-0000-0000000000f1';
  if v_ar <> false then raise exception 'FAIL: own sub auto_renew expected false, got %', v_ar; end if;
  if v_seats <> 10 or v_mrr <> 8640 then raise exception 'FAIL: seats/mrr mutated (% / %)', v_seats, v_mrr; end if;

  begin
    perform public.set_subscription_auto_renew('aaaaaaaa-0000-0000-0000-0000000000f2', false);
  exception when others then v_err := true;
  end;
  if not v_err then raise exception 'FAIL: toggling another customer''s sub did NOT raise'; end if;
  select auto_renew into v_b_ar from public.subscriptions where id='aaaaaaaa-0000-0000-0000-0000000000f2';
  if v_b_ar <> true then raise exception 'FAIL: customer B auto_renew changed (cross-customer write!)'; end if;

  raise notice 'PASS: own toggle works (seats/mrr intact), cross-customer blocked';
end $$;
rollback;
