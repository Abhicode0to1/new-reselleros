-- Regression test: hierarchy peer isolation — Rep A cannot reach Rep B's records, their
-- shared manager reaches both, an owner sees everything, and an UNOWNED row stays visible
-- to all of them. Migration 20260818150000 (Sections 3a + 3b). Self-asserting; rolled back.
--
-- ✅ FIRST RUN 22 Aug 2026 — four days after it was written, and it did not survive it.
--    (Header until then: "NOT YET RUN … treat every claim below as what this asserts, not
--    what has passed." That caution was well placed.) The fixture insert died on a duplicate
--    `users_pkey` before any assertion executed, because it borrowed auth ids that already
--    had public.users rows — fixed below. Nothing about the POLICIES had ever been exercised.
--
--        npx supabase db query --linked -f supabase/tests/hierarchy_peer_isolation.test.sql
--
--    Expect one NOTICE beginning "PASS hierarchy:". Any FAIL or SKIP is the test working.
--
-- ─── IT IS SAFE TO RUN AGAINST PRODUCTION, AND THAT IS MEASURED ──────────────
--    The other 31 tests here say "run on a dev/test DB", which is the right default for a
--    file full of INSERTs. This one was checked rather than assumed, because the whole
--    design depends on rollback actually happening.
--
--    Probe run through the same channel on 18 Aug 2026:
--        begin; create temp table probe_txn(x int); insert into probe_txn values (1);
--        rollback; select 'AUTOCOMMIT_DANGER' from probe_txn;
--    Result: `ERROR 42P01: relation "probe_txn" does not exist`. The temp table and its row
--    were gone, so `supabase db query -f` runs the file in ONE session, in order, and
--    honours begin/rollback. Had it autocommitted each statement the probe would have
--    printed AUTOCOMMIT_DANGER — and this test would have left a fake tenant, four users
--    and three leads in the live books.
--
--    Two things it still costs, both small and worth knowing: creating the policies takes a
--    brief ACCESS EXCLUSIVE lock on `leads` (14 rows, milliseconds), and other sessions
--    never see the uncommitted policies — they would queue on that lock instead. An
--    exception anywhere aborts the transaction, which also rolls everything back.
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
-- Four synthetic auth users, created here and rolled back with everything else.
--
-- ⚠️ THIS FILE USED TO BORROW REAL AUTH IDS, AND THAT IS WHY IT HAD NEVER PASSED.
--    First execution, 22 Aug 2026, four days after it was written:
--
--    1. Borrowing the four lowest-ordered `auth.users` ids and inserting them into
--       `public.users` died on `duplicate key value violates unique constraint
--       "users_pkey"`. The FK the original comment verified (public.users.id →
--       auth.users(id)) is necessary but not sufficient — an auth id is only free to
--       borrow if it has no `public.users` row yet, and the sandbox tester's does.
--    2. Excluding ids that already have a public.users row then reported
--       `SKIP: need 4 auth.users rows with no public.users row to borrow, found 1`.
--       On this database almost every auth user is already a member of a tenant, so the
--       borrowing design cannot work here at all — it depends on spare accounts existing.
--
--    So it now creates its own, which is the idiom the sibling test in this folder already
--    uses (`sandbox_tenant_isolation.test.sql` inserts its own auth row and rolls it back).
--    Deterministic ids, no dependence on who happens to have signed up, and no way for a
--    real person's row to collide with a fixture.
--
--    The old comment's promise that "auth.users is never written to" no longer holds — it
--    IS written to, inside the transaction, and rolled back with the rest. That is a
--    deliberate trade: a fixture that owns its data beats one that borrows a stranger's.
insert into auth.users (id, email) values
  ('d1d1d1d1-0000-4000-8000-00000000000a', 'hier-owner@example.test'),
  ('d1d1d1d1-0000-4000-8000-00000000000b', 'hier-mgr@example.test'),
  ('d1d1d1d1-0000-4000-8000-00000000000c', 'hier-repa@example.test'),
  ('d1d1d1d1-0000-4000-8000-00000000000d', 'hier-repb@example.test');

do $$
begin
  /* Transaction-local GUCs rather than a temp table: `set local role authenticated` cannot
     read a temp table owned by the connection role, but it can read these. */
  perform set_config('hier.owner', 'd1d1d1d1-0000-4000-8000-00000000000a', true);
  perform set_config('hier.mgr',   'd1d1d1d1-0000-4000-8000-00000000000b', true);
  perform set_config('hier.repa',  'd1d1d1d1-0000-4000-8000-00000000000c', true);
  perform set_config('hier.repb',  'd1d1d1d1-0000-4000-8000-00000000000d', true);
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
      -- Only the roles that compete over pipeline are scoped by the tree. Everybody else
      -- reads tenant-wide, because they service records they do not own. See the migration.
      or exists (select 1 from public.users u
                  where u.id = auth.uid()
                    and u.role not in ('sales','sales_senior','manager'))
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

/* A NOTICE is not enough, and 22 Aug 2026 is how we know. Through `supabase db query -f` a
   notice is invisible: the run came back exit 0 with `"rows": []`, which is exactly what a
   file that asserted NOTHING would also return. Every assertion above raises on failure, so
   reaching this line means they all passed — but only a visible row says so out loud.
   Same device as sandbox_tenant_isolation.test.sql: one row, unmistakable. */
select 'PASS' as hierarchy_peer_isolation;

-- Fixtures, function and policies all disappear here.
rollback;
