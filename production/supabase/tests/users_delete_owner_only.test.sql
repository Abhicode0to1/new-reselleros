-- Regression test for 20260901100000_users_delete_owner_only.sql
--
-- WHAT IT PROVES (self-asserting; whole file rolls back)
--   1. A sales user CANNOT delete the owner's row.        ← the audit hole
--   2. A sales user CANNOT delete their own row.
--   3. The owner CAN delete a teammate's row.             ← not bricked
--   4. The owner CANNOT delete their OWN row.             ← last-owner lock
--   5. The delete in (3) leaves an activity_log row.      ← audit trigger
--
-- RLS-delete refuses silently (0 rows), isliye yahan row-count hi nishaan
-- hai — dono disha naapte hain (block par count same, allow par count-1),
-- aur trigger wala case activity_log ki row maangta hai, sirf count nahi.

begin;

insert into auth.users (id, email) values
  ('d1d1d1d1-0000-0000-0000-0000000000a1', 'del-owner@example.test'),
  ('d1d1d1d1-0000-0000-0000-0000000000a2', 'del-sales@example.test'),
  ('d1d1d1d1-0000-0000-0000-0000000000a3', 'del-victim@example.test');

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('d1d1d1d1-0000-0000-0000-0000000000f0', 'DEL T', 'del@example.test', '07', 'DEL1');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('d1d1d1d1-0000-0000-0000-0000000000a1', 'd1d1d1d1-0000-0000-0000-0000000000f0', 'del-owner@example.test',  'Del Owner',  'owner', true),
  ('d1d1d1d1-0000-0000-0000-0000000000a2', 'd1d1d1d1-0000-0000-0000-0000000000f0', 'del-sales@example.test',  'Del Sales',  'sales', true),
  ('d1d1d1d1-0000-0000-0000-0000000000a3', 'd1d1d1d1-0000-0000-0000-0000000000f0', 'del-victim@example.test', 'Del Victim', 'sales', true);

set local role authenticated;

do $$
declare
  v_owner  uuid := 'd1d1d1d1-0000-0000-0000-0000000000a1';
  v_sales  uuid := 'd1d1d1d1-0000-0000-0000-0000000000a2';
  v_victim uuid := 'd1d1d1d1-0000-0000-0000-0000000000a3';
  v_n int;
begin
  -- ── 1. sales tries to delete the OWNER ─────────────────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_sales, 'role', 'authenticated')::text, true);

  delete from public.users where id = v_owner;
  select count(*) into v_n from public.users where id = v_owner;
  if v_n <> 1 then
    raise exception 'FAIL 1: sales user deleted the owner — the audit hole is open';
  end if;

  -- ── 2. sales tries to delete THEMSELF ──────────────────────────────────
  delete from public.users where id = v_sales;
  select count(*) into v_n from public.users where id = v_sales;
  if v_n <> 1 then
    raise exception 'FAIL 2: a non-owner deleted their own row';
  end if;

  -- ── 3. owner deletes a teammate — allowed ──────────────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  delete from public.users where id = v_victim;
  select count(*) into v_n from public.users where id = v_victim;
  if v_n <> 0 then
    raise exception 'FAIL 3: owner could not delete a teammate — over-blocked';
  end if;

  -- ── 5. and that delete left an audit row ───────────────────────────────
  select count(*) into v_n from public.activity_log
   where entity = 'users' and action = 'delete'
     and entity_id = v_victim::text;
  if v_n < 1 then
    raise exception 'FAIL 5: teammate delete left no activity_log row — audit trigger missing';
  end if;

  -- ── 4. owner cannot delete their OWN row ───────────────────────────────
  delete from public.users where id = v_owner;
  select count(*) into v_n from public.users where id = v_owner;
  if v_n <> 1 then
    raise exception 'FAIL 4: owner deleted their own row — last-owner lock gone';
  end if;

  raise notice 'PASS: users delete is owner-only, self-delete blocked, audited';
end $$;

rollback;
