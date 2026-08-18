-- Regression test for migration 20260818160000_users_privileged_columns_owner_only.sql
-- (trigger `users_privileged_columns_guard` → fn `guard_privileged_user_columns`).
--
-- WHY THIS FILE EXISTS
--   The migration was applied to production on 18 Aug 2026 and confirmed present
--   (trigger_exists 1, fn_exists 1) — but "it blocks a non-owner" was only ever
--   REASONED, never executed. The migration's own HOW TO VERIFY says the real test
--   "needs two sessions and cannot be done from a superuser connection", which sent
--   the check to a human and so it never happened. That is wrong on one point: a
--   superuser connection takes the carve-out only because it has no auth.uid() —
--   and auth.uid() is just `request.jwt.claims ->> 'sub'`, which `set_config` can
--   set. So both sides are testable from one connection, the same way
--   portal_customer_users_no_self_update.test.sql already does it.
--
-- WHAT IT PROVES (each case FAILS LOUDLY, the file is self-asserting)
--   1. A support user CANNOT escalate their own role to owner.        ← the hole
--   2. A support user CANNOT re-point a teammate's manager_id.        ← hierarchy
--   3. A support user CAN still edit their own full_name.             ← no over-block
--   4. An owner CAN change a teammate's role.                         ← not bricked
--   5. A caller with no auth.uid() (service_role) passes through.     ← the carve-out
--
-- CASE 1 IS ONLY MEANINGFUL BECAUSE RLS LETS IT THROUGH. Read live off pg_policies:
--   users_self_update    UPDATE using (id = auth.uid())              with_check NULL
--   users_tenant_update  UPDATE using (tenant_id = current_tenant_id()) with_check NULL
-- Neither restricts columns, so the UPDATE reaches the row and only the trigger stops
-- it. The assertions therefore demand the trigger's OWN message — a bare "0 rows
-- changed" would pass a column test for the wrong reason (RLS refusing the row), and
-- would keep passing on the day the trigger is dropped.
--
-- SAFETY: three synthetic auth identities in a synthetic tenant, and the whole file is
-- one transaction ending in ROLLBACK. No real row is read into an assertion or written.
-- auth.users has no triggers on it (checked), so the inserts create nothing on the side.

begin;

-- Synthetic identities. public.users.id is FK → auth.users(id), so the auth rows must
-- exist first; only `id` is NOT NULL without a default there.
insert into auth.users (id, email) values
  ('b1b1b1b1-0000-0000-0000-0000000000e1', 'guard-owner@example.test'),
  ('b1b1b1b1-0000-0000-0000-0000000000e2', 'guard-support@example.test'),
  ('b1b1b1b1-0000-0000-0000-0000000000e3', 'guard-victim@example.test');

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('b1b1b1b1-0000-0000-0000-0000000000f0', 'GUARD T', 'guard@example.test', '07', 'GRD1');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b1b1b1b1-0000-0000-0000-0000000000e1', 'b1b1b1b1-0000-0000-0000-0000000000f0', 'guard-owner@example.test',   'Guard Owner',   'owner',   true),
  ('b1b1b1b1-0000-0000-0000-0000000000e2', 'b1b1b1b1-0000-0000-0000-0000000000f0', 'guard-support@example.test', 'Guard Support', 'support', true),
  ('b1b1b1b1-0000-0000-0000-0000000000e3', 'b1b1b1b1-0000-0000-0000-0000000000f0', 'guard-victim@example.test',  'Guard Victim',  'sales',   true);

-- `authenticated` is the role a real browser token arrives as, so RLS is actually
-- enforced below. A superuser connection would bypass RLS and prove less.
set local role authenticated;

do $$
declare
  v_support uuid := 'b1b1b1b1-0000-0000-0000-0000000000e2';
  v_victim  uuid := 'b1b1b1b1-0000-0000-0000-0000000000e3';
  v_blocked boolean;
  v_msg     text;
  v_role    text;
  v_name    text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_support::text, 'role', 'authenticated')::text, true);

  if auth.uid() <> v_support then
    raise exception 'SETUP FAIL: auth.uid() is % — the impersonation itself did not take', auth.uid();
  end if;

  ---------------------------------------------------------------- 1. self-escalation
  v_blocked := false;
  begin
    update public.users set role = 'owner' where id = v_support;
  exception when others then
    v_blocked := true; v_msg := sqlerrm;
  end;
  if not v_blocked then
    raise exception 'FAIL 1: a support user escalated their own role to owner — the trigger did not fire';
  end if;
  if v_msg not like 'Only an owner%' then
    raise exception 'FAIL 1: blocked, but by something other than the guard: %', v_msg;
  end if;

  ------------------------------------------------------------- 2. hijack a reporting line
  v_blocked := false;
  begin
    update public.users set manager_id = v_support where id = v_victim;
  exception when others then
    v_blocked := true; v_msg := sqlerrm;
  end;
  if not v_blocked then
    raise exception 'FAIL 2: a support user re-pointed a teammate manager_id — hierarchy visibility is writable by anyone';
  end if;
  if v_msg not like 'Only an owner%' then
    raise exception 'FAIL 2: blocked, but by something other than the guard: %', v_msg;
  end if;

  ------------------------------------------------------- 3. ordinary self-edit still works
  begin
    update public.users set full_name = 'Guard Support Renamed' where id = v_support;
  exception when others then
    raise exception 'FAIL 3: the guard blocked an ordinary self-edit (full_name): %', sqlerrm;
  end;
  select full_name into v_name from public.users where id = v_support;
  if v_name <> 'Guard Support Renamed' then
    raise exception 'FAIL 3: full_name did not change (got %) — over-blocked or refused by RLS', v_name;
  end if;

  ---------------------------------------------------------------- 4. an owner may do it
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'b1b1b1b1-0000-0000-0000-0000000000e1', 'role', 'authenticated')::text, true);
  begin
    update public.users set role = 'manager', manager_id = 'b1b1b1b1-0000-0000-0000-0000000000e1'
     where id = v_victim;
  exception when others then
    raise exception 'FAIL 4: an OWNER was blocked from changing a teammate role — the guard is bricking the Team page: %', sqlerrm;
  end;
  select role::text into v_role from public.users where id = v_victim;
  if v_role <> 'manager' then
    raise exception 'FAIL 4: owner update did not stick (role is %)', v_role;
  end if;
end $$;

reset role;

do $$
declare
  v_victim uuid := 'b1b1b1b1-0000-0000-0000-0000000000e3';
  v_role   text;
begin
  ------------------------------------------------- 5. the service_role carve-out holds
  -- No auth.uid() — the OAuth callback / claim-merge / reset-data paths. If this ever
  -- starts raising, sign-in for new teammates breaks, which is worse than the hole.
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  if auth.uid() is not null then
    raise exception 'SETUP FAIL: auth.uid() is still % — case 5 would not be testing the carve-out', auth.uid();
  end if;

  begin
    update public.users set role = 'billing', is_active = false where id = v_victim;
  exception when others then
    raise exception 'FAIL 5: the carve-out is gone — a server path with no auth.uid() was blocked: %', sqlerrm;
  end;
  select role::text into v_role from public.users where id = v_victim;
  if v_role <> 'billing' then
    raise exception 'FAIL 5: service-path update did not stick (role is %)', v_role;
  end if;
end $$;

select 'PASS — guard blocks non-owner role + manager_id writes, allows self-edits, allows owner, keeps the no-auth.uid() carve-out' as result;

rollback;
