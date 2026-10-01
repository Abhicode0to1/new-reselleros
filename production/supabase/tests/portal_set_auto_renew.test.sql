-- Regression test: portal customer can toggle ONLY their own subscription's
-- auto-renew (migration 0062). Run on a dev/test DB. Self-asserting; rolled back.
--
-- Proves:
--   1. A logged-in customer toggles their own sub → auto_renew flips, seats/mrr
--      untouched, RPC returns the new value.
--   2. The same customer cannot toggle ANOTHER customer's sub → RPC raises and
--      that sub is unchanged (no cross-customer write).
--   3. The toggle lands in the activity feed as "Customer <name>" (R-016,
--      migration 20260930200001): user_id null — a portal customer is not in
--      public.users, the FK that used to fail and roll the toggle back —
--      actor_label 'Customer Cust A', and the auto_renew true→false change recorded.
--
-- This fixture OWNS its auth user (AGENTS.md L11). It used to borrow one with
-- `select id from auth.users limit 1`, and that is why it failed:
-- customer_users.auth_user_id is UNIQUE, so the borrow dies with a duplicate key
-- the moment the borrowed user already has a portal link. It passed on
-- production only because of which row happened to come back first, which is
-- luck rather than design and could have broken any day.

begin;
-- ── setup (service_role) ──
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('ffffffff-0000-0000-0000-0000000000f1','PORTAL T','pt@example.in','07','PRT1');
insert into public.customers (id, tenant_id, name, contact_email)
  values ('cccccccc-0000-0000-0000-0000000000f1','ffffffff-0000-0000-0000-0000000000f1','Cust A','a@portal.in'),
         ('cccccccc-0000-0000-0000-0000000000f2','ffffffff-0000-0000-0000-0000000000f1','Cust B','b@portal.in');
-- Own the auth user rather than borrowing one, so this file does not depend on
-- what the operator did to their data last week.
insert into auth.users (id, email)
  values ('dddddddd-0000-0000-0000-0000000000f1','portal-tester@example.test');
insert into public.customer_users (auth_user_id, customer_id, tenant_id, email, role)
  values ('dddddddd-0000-0000-0000-0000000000f1','cccccccc-0000-0000-0000-0000000000f1',
          'ffffffff-0000-0000-0000-0000000000f1','a@portal.in','admin');
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, start_date, renewal_date, auto_renew)
  values ('aaaaaaaa-0000-0000-0000-0000000000f1','ffffffff-0000-0000-0000-0000000000f1','cccccccc-0000-0000-0000-0000000000f1','Cust A','Google Workspace Standard','google',10,8640,'active',current_date,current_date+365,true),
         ('aaaaaaaa-0000-0000-0000-0000000000f2','ffffffff-0000-0000-0000-0000000000f1','cccccccc-0000-0000-0000-0000000000f2','Cust B','Google Workspace Standard','google',5,4320,'active',current_date,current_date+365,true);

-- ── act as customer A (authenticated) ──
do $$
declare v_uid text; v_ret boolean; v_ar boolean; v_seats int; v_mrr int; v_b_ar boolean; v_err boolean := false;
        v_log record; v_n int;
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

  -- 3. the activity feed names the customer
  select count(*) into v_n from public.activity_log
   where entity = 'subscriptions' and entity_id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
  if v_n <> 1 then raise exception 'FAIL: expected 1 activity row for the toggle, got %', v_n; end if;
  select user_id, actor_label, action, changes into v_log from public.activity_log
   where entity = 'subscriptions' and entity_id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
  if v_log.user_id is not null then raise exception 'FAIL: activity user_id should be null for a portal customer, got %', v_log.user_id; end if;
  if v_log.actor_label is distinct from 'Customer Cust A' then raise exception 'FAIL: actor_label expected "Customer Cust A", got %', v_log.actor_label; end if;
  if v_log.action <> 'update' then raise exception 'FAIL: action expected update, got %', v_log.action; end if;
  if v_log.changes->'auto_renew' is distinct from '{"old": true, "new": false}'::jsonb then
    raise exception 'FAIL: changes.auto_renew expected true->false, got %', v_log.changes->'auto_renew';
  end if;
  -- the blocked attempt on customer B left no activity behind
  select count(*) into v_n from public.activity_log
   where entity = 'subscriptions' and entity_id = 'aaaaaaaa-0000-0000-0000-0000000000f2' and action = 'update';
  if v_n <> 0 then raise exception 'FAIL: blocked toggle on customer B wrote % activity row(s)', v_n; end if;

  raise notice 'PASS: own toggle works (seats/mrr intact), cross-customer blocked, activity says Customer Cust A';
end $$;
rollback;
