-- Regression test: hierarchy peer isolation — Rep A cannot reach Rep B's records, their
-- shared manager reaches both, an owner sees everything, and an UNOWNED row stays visible
-- to all of them. Migration 20260818150000 (Sections 3a + 3b). Self-asserting; rolled back.
--
-- ⚠️ NOT YET RUN. Written 18 Aug 2026, against a schema whose shape was checked
--    (users.id → auth.users, and the NOT NULL columns below) but never executed, because
--    there is no dev/test database on this machine and these fixtures must NOT be pointed
--    at production. Treat every claim below as "what this asserts", not "what has passed".
--    To run it, on a dev/test DB only:
--        npx supabase db query --db-url "<dev connection string>" -f supabase/tests/hierarchy_peer_isolation.test.sql
--    Expect one NOTICE beginning "PASS hierarchy:". Any FAIL/SKIP is the test working.
--
-- ─── WHY THIS TEST CAN EXIST BEFORE THE MIGRATION IS APPLIED ─────────────────
-- DDL is transactional in Postgres, so this test CREATES the predicate function and the
-- restrictive policies itself, proves them, and rolls the whole lot back. That means
-- Section 3b can stop being reasoned-only WITHOUT anybody deciding today whether support
-- staff should see the pipeline — the two questions are finally separate.
--
-- Copy the CREATE POLICY statements from the migration whenever they change there. If they
-- drift, this test proves something the database does not do.
--
-- ─── `set local role authenticated` IS THE TEST ──────────────────────────────
-- An owner/superuser connection BYPASSES RLS entirely. Without the role switch this file
-- would report PASS against a database with no policies at all — precisely the failure it
-- exists to catch. Same reason the ids are read BEFORE the switch: afterwards, users' own
-- RLS hides them until a JWT is set.
--
-- Asserts:
--   1. Rep A sees their own lead + the unowned one. NOT Rep B's.
--   2. Rep B mirrors it. Checked separately — a policy that read the wrong column, or
--      hardcoded an id, passes case 1 and fails here.
--   3. Their shared manager sees both reps' leads + the unowned = 3.
--   4. The owner sees all 3 by role, despite having no reports.
--   5. Rep A cannot UPDATE Rep B's lead. leads_update is tenant-wide, so without the
--      restrictive write policy a blind write by id goes straight through — worse than a
--      read, because it changes something.
--   6. Rep A can still read and update their OWN lead: the policy narrows, it does not brick.

begin;

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- public.users.id references auth.users(id) — verified against the live schema — so four
-- real auth ids are borrowed, ordered for determinism. auth.users is never written to, and
-- every insert below is rolled back.
do $$
declare
  v_n int;
begin
  select count(*) into v_n from (select 1 from auth.users limit 4) s;
  if v_n < 4 then
    raise exception 'SKIP: need 4 auth.users rows to borrow ids, found %', v_n;
  end if;

  /* Transaction-local GUCs rather than a temp table: `set local role authenticated` cannot
     read a temp table owned by the connection role, but it can read these. */
  perform set_config('hier.owner', (select id::text from auth.users order by id offset 0 limit 1), true);
  perform set_config('hier.mgr',   (select id::text from auth.users order by id offset 1 limit 1), true);
  perform set_config('hier.repa',  (select id::text from auth.users order by id offset 2 limit 1), true);
  perform set_config('hier.repb',  (select id::text from auth.users order by id offset 3 limit 1), true);
end $$;

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-0000000000d1', 'HIER T', 'hier@example.in', '07', 'HIE1');

-- owner → all by role. manager → two reports. repA / repB → peers under that manager.
insert into public.users (id, tenant_id, email, full_name, role, is_active, manager_id) values
  (current_setting('hier.owner')::uuid, 'dddddddd-0000-0000-0000-0000000000d1',
   'hier-owner@example.in', 'Hier Owner', 'owner', true, null),
  (current_setting('hier.mgr')::uuid, 'dddddddd-0000-0000-0000-0000000000d1',
   'hier-mgr@example.in', 'Hier Manager', 'manager', true, null),
  (current_setting('hier.repa')::uuid, 'dddddddd-0000-0000-0000-0000000000d1',
   'hier-repa@example.in', 'Hier Rep A', 'sales', true, current_setting('hier.mgr')::uuid),
  (current_setting('hier.repb')::uuid, 'dddddddd-0000-0000-0000-0000000000d1',
   'hier-repb@example.in', 'Hier Rep B', 'sales', true, current_setting('hier.mgr')::uuid);

insert into public.leads (id, tenant_id, company, owner_id) values
  ('L-HIER-A',    'dddddddd-0000-0000-0000-0000000000d1', 'Rep A Co',     current_setting('hier.repa')::uuid),
  ('L-HIER-B',    'dddddddd-0000-0000-0000-0000000000d1', 'Rep B Co',     current_setting('hier.repb')::uuid),
  ('L-HIER-NULL', 'dddddddd-0000-0000-0000-0000000000d1', 'Unclaimed Co', null);

-- ── The migration under test (3a + 3b, leads only — the table with real owners) ──
create or replace function public.can_see_record(p_owner uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $fn$
  select p_owner is null
      or public.current_customer_id() is not null
      or exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner')
      or p_owner in (select public.get_subordinate_user_ids(auth.uid()))
$fn$;

drop policy if exists leads_hierarchy_select on public.leads;
create policy leads_hierarchy_select on public.leads
  as restrictive for select using (public.can_see_record(owner_id));

drop policy if exists leads_hierarchy_write on public.leads;
create policy leads_hierarchy_write on public.leads
  as restrictive for update using (public.can_see_record(owner_id));

-- ── The assertions. RLS only bites once we stop being the connection owner. ──
set local role authenticated;

do $$
declare
  v_cnt int;
  v_ids text;
begin
  -- 1) Rep A: own + unowned, never Rep B's.
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('hier.repa'), 'role', 'authenticated')::text, true);
  select count(*), string_agg(id, ',' order by id) into v_cnt, v_ids
    from public.leads where id like 'L-HIER-%';
  if v_ids is distinct from 'L-HIER-A,L-HIER-NULL' then
    raise exception 'FAIL rep A: expected own + unowned, got [%] (count %)', v_ids, v_cnt;
  end if;

  -- 2) Rep B: the mirror image.
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('hier.repb'), 'role', 'authenticated')::text, true);
  select string_agg(id, ',' order by id) into v_ids
    from public.leads where id like 'L-HIER-%';
  if v_ids is distinct from 'L-HIER-B,L-HIER-NULL' then
    raise exception 'FAIL rep B: expected own + unowned, got [%]', v_ids;
  end if;

  -- 3) The shared manager sees both branches.
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('hier.mgr'), 'role', 'authenticated')::text, true);
  select string_agg(id, ',' order by id) into v_ids
    from public.leads where id like 'L-HIER-%';
  if v_ids is distinct from 'L-HIER-A,L-HIER-B,L-HIER-NULL' then
    raise exception 'FAIL manager: expected all three, got [%]', v_ids;
  end if;

  -- 4) The owner sees everything by role, with no reports at all.
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('hier.owner'), 'role', 'authenticated')::text, true);
  select count(*) into v_cnt from public.leads where id like 'L-HIER-%';
  if v_cnt <> 3 then
    raise exception 'FAIL owner: expected 3 leads, got %', v_cnt;
  end if;

  -- 5) A row you cannot read must not be writable by id.
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('hier.repa'), 'role', 'authenticated')::text, true);
  update public.leads set company = 'HIJACKED' where id = 'L-HIER-B';
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then
    raise exception 'FAIL blind write: rep A updated % row(s) of rep B''s lead', v_cnt;
  end if;

  -- 6) …and the rep's own work still goes through.
  update public.leads set company = 'Rep A Co (edited)' where id = 'L-HIER-A';
  get diagnostics v_cnt = row_count;
  if v_cnt <> 1 then
    raise exception 'FAIL own write: rep A could not update their own lead (% rows)', v_cnt;
  end if;

  raise notice 'PASS hierarchy: A sees own+unowned, B mirrors, manager sees both, owner sees all, blind write blocked, own write allowed';
end $$;

reset role;

-- Fixtures, function and policies all disappear here.
rollback;
