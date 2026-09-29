-- Regression test: S13 (RLS InitPlan wrap + hierarchy helpers) and S14 (hot
-- (tenant_id, date) indexes). Self-asserting; everything is rolled back.
--
-- Local:  pipe into psql against the local replica (see the test-sql runner notes).
-- Harness: npm run test:sql  (bundled with the others, each in its own begin … rollback)
--
-- ─── IT APPLIES THE MIGRATIONS ITSELF ────────────────────────────────────────
-- The two migration files are copied in VERBATIM between the INLINE markers below, so this
-- proves them before they are applied anywhere, and is a no-op re-apply after (both are
-- idempotent). tests/rls-initplan-migrations.test.ts fails the vitest suite if either copy
-- drifts from its migration file — re-copy, don't hand-edit.
--
-- Asserts:
--   1. No public policy calls current_tenant_id() / current_customer_id() /
--      current_user_is_owner() / auth.uid() / auth.role() / auth.jwt() bare (i.e. not as
--      an InitPlan); nothing double-wrapped; no policy calls can_see_record(column); the
--      nine hierarchy policies are still RESTRICTIVE; all 15 S14 indexes exist and lead on
--      tenant_id.
--   2. Under the migrated policies, as `authenticated`: rep A sees own + unowned only,
--      rep B mirrors, the manager sees both, the owner sees all of their tenant and none of
--      another's, a second tenant sees only its own row, blind update/delete of a peer's or
--      another tenant's lead hits 0 rows, own update hits 1, a JWT with no sub sees nothing,
--      and the leads plan contains an InitPlan and no can_see_record call.
--
-- RED-CHECKED 28 Sep 2026 on the local replica: with the INLINE blocks removed it fails
-- with "FAIL S13: 386 public policies still call an identity function per row".

begin;

-- >>> INLINE 20260928100000_rls_initplan_wrap.sql >>>
-- ============================================================================
-- S13 — RLS policies: evaluate the caller's identity ONCE per query, not once per row.
--
-- ─── THE PROBLEM ─────────────────────────────────────────────────────────────
-- Almost every policy in `public` reads `tenant_id = current_tenant_id()`. Written bare,
-- Postgres plans that as a per-row Filter: current_tenant_id() (a SECURITY DEFINER lookup
-- on public.users) runs once for every row the scan touches. Wrapped as
-- `(select current_tenant_id())` the planner hoists it into an InitPlan — one call, the
-- result reused as a parameter for every row. Same answer, because the function is STABLE
-- and takes no row input; only the number of calls changes. This is the fix Supabase's
-- `auth_rls_initplan` advisor asks for.
--
-- The hierarchy policies were worse: `can_see_record(owner_id)` takes a COLUMN argument, so
-- it can never be hoisted — 20k leads meant 20k calls, each one potentially running the
-- recursive get_subordinate_user_ids() walk. They are rewritten here against two
-- zero-argument helpers that CAN be hoisted:
--
--     owner_id is null
--     or (select public.hierarchy_sees_all())
--     or owner_id = any ((select public.visible_owner_ids())::uuid[])
--
-- which is branch-for-branch the body of can_see_record(p_owner) with the per-row part
-- (the owner) moved outside the function. can_see_record() itself is left untouched — no
-- policy uses it after this, but dropping a granted function is a separate decision.
--
-- ─── WHAT GETS WRAPPED ───────────────────────────────────────────────────────
-- Every zero-argument STABLE identity function that appears in a public policy:
--     current_tenant_id()  current_customer_id()  current_user_is_owner()
--     auth.uid()  auth.role()  auth.jwt()
-- The last three are included because the advisor flags them for the same reason and the
-- rewrite is identical; leaving auth.uid() bare would keep ~85 policies on the per-row path.
--
-- Only schema `public`. The 17 storage.objects policies are NOT touched: storage.objects is
-- owned by supabase_storage_admin on hosted Supabase, and ALTER POLICY needs the table
-- owner — a failure there would abort this whole migration. That is a follow-up, not a
-- silent skip.
--
-- ─── HOW ─────────────────────────────────────────────────────────────────────
-- Programmatic, from pg_policies, so it covers whatever the target database actually has
-- (production's policy set is not byte-identical to any file in this repo). For each
-- policy with a bare call it issues ALTER POLICY … USING (…) WITH CHECK (…). ALTER POLICY
-- keeps the policy's name, command, roles and PERMISSIVE/RESTRICTIVE flag exactly as they
-- are — only the expressions change. An expression that is NULL (e.g. the WITH CHECK of a
-- policy that falls back to USING) is left NULL, so the fallback is preserved too.
--
-- IDEMPOTENT: the pattern refuses to match a call that is already `( SELECT fn() …`, which
-- is how pg_get_expr prints a wrapped call — so a second run finds nothing to change and
-- nothing gets double-wrapped. The block ends by re-reading pg_policies and raising if any
-- bare call survived, so a partial rewrite cannot report success.
--
-- Regression test: supabase/tests/rls_initplan_and_hot_indexes.test.sql (applies this file
-- inside begin … rollback and re-proves hierarchy peer isolation against these policies).
-- ============================================================================

-- ─── 1. Hierarchy helpers: zero-argument, so a policy can hoist them ─────────

/* Does the caller read tenant-wide, regardless of who owns the row?
   The two non-owner branches of can_see_record(), verbatim. The role list MUST match
   PEER_SCOPED_ROLES in src/lib/team/visibility.ts (hierarchy-policy.test.ts checks it). */
create or replace function public.hierarchy_sees_all() returns boolean language sql stable security definer set search_path = public, pg_temp as $$ select public.current_customer_id() is not null or exists (select 1 from public.users u where u.id = auth.uid() and u.role not in ('sales','sales_senior','manager')) $$;

comment on function public.hierarchy_sees_all() is
  'True when the caller is NOT scoped by the reporting tree: a portal customer, or a staff role other than sales/sales_senior/manager. Zero-argument so RLS can evaluate it once per query as an InitPlan: (select public.hierarchy_sees_all()).';

/* Every owner id the caller may see through the tree (themselves + everybody below).
   An array, not a set, so a policy can say `owner_id = any ((select …))` and the planner
   evaluates it once. Empty array — never NULL — when there is no caller, so the ANY test
   is plainly false rather than unknown. */
create or replace function public.visible_owner_ids() returns uuid[] language sql stable security definer set search_path = public, pg_temp as $$ select coalesce(array_agg(t.id), '{}'::uuid[]) from public.get_subordinate_user_ids(auth.uid()) as t(id) $$;

comment on function public.visible_owner_ids() is
  'Owner ids visible to the caller through the reporting tree (get_subordinate_user_ids(auth.uid()) as an array; empty, never NULL). For RLS: owner_id = any ((select public.visible_owner_ids())::uuid[]).';

revoke all on function public.hierarchy_sees_all() from public;
revoke all on function public.visible_owner_ids() from public;
grant execute on function public.hierarchy_sees_all() to authenticated, anon;
grant execute on function public.visible_owner_ids() to authenticated, anon;

-- ─── 2. The nine hierarchy policies, same names / commands / RESTRICTIVE ─────
-- Default roles (public), exactly as 20260818150000 created them.

drop policy if exists leads_hierarchy_select on public.leads;
create policy leads_hierarchy_select on public.leads
  as restrictive for select
  using (owner_id is null or (select public.hierarchy_sees_all()) or owner_id = any ((select public.visible_owner_ids())::uuid[]));
drop policy if exists leads_hierarchy_write on public.leads;
create policy leads_hierarchy_write on public.leads
  as restrictive for update
  using (owner_id is null or (select public.hierarchy_sees_all()) or owner_id = any ((select public.visible_owner_ids())::uuid[]));
drop policy if exists leads_hierarchy_delete on public.leads;
create policy leads_hierarchy_delete on public.leads
  as restrictive for delete
  using (owner_id is null or (select public.hierarchy_sees_all()) or owner_id = any ((select public.visible_owner_ids())::uuid[]));

drop policy if exists quotes_hierarchy_select on public.quotes;
create policy quotes_hierarchy_select on public.quotes
  as restrictive for select
  using (owner_id is null or (select public.hierarchy_sees_all()) or owner_id = any ((select public.visible_owner_ids())::uuid[]));
drop policy if exists quotes_hierarchy_write on public.quotes;
create policy quotes_hierarchy_write on public.quotes
  as restrictive for update
  using (owner_id is null or (select public.hierarchy_sees_all()) or owner_id = any ((select public.visible_owner_ids())::uuid[]));
drop policy if exists quotes_hierarchy_delete on public.quotes;
create policy quotes_hierarchy_delete on public.quotes
  as restrictive for delete
  using (owner_id is null or (select public.hierarchy_sees_all()) or owner_id = any ((select public.visible_owner_ids())::uuid[]));

drop policy if exists customers_hierarchy_select on public.customers;
create policy customers_hierarchy_select on public.customers
  as restrictive for select
  using (account_manager_id is null or (select public.hierarchy_sees_all()) or account_manager_id = any ((select public.visible_owner_ids())::uuid[]));
drop policy if exists customers_hierarchy_write on public.customers;
create policy customers_hierarchy_write on public.customers
  as restrictive for update
  using (account_manager_id is null or (select public.hierarchy_sees_all()) or account_manager_id = any ((select public.visible_owner_ids())::uuid[]));
drop policy if exists customers_hierarchy_delete on public.customers;
create policy customers_hierarchy_delete on public.customers
  as restrictive for delete
  using (account_manager_id is null or (select public.hierarchy_sees_all()) or account_manager_id = any ((select public.visible_owner_ids())::uuid[]));

-- ─── 3. Wrap every bare identity call in every public policy ─────────────────
do $rewrite$
declare
  /* A bare call: not preceded by an identifier character or '.', and not preceded by
     'SELECT ' — pg_get_expr prints an already-wrapped call as `( SELECT fn() AS fn)`.
     The first lookbehind also stops `uid()` matching inside `auth.uid()` on its own. */
  re constant text :=
    '(?<![[:alnum:]_.])(?<!SELECT )('
    || '(?:public\.)?current_tenant_id\(\)'
    || '|(?:public\.)?current_customer_id\(\)'
    || '|(?:public\.)?current_user_is_owner\(\)'
    || '|auth\.uid\(\)|auth\.role\(\)|auth\.jwt\(\)'
    || ')';
  p         record;
  v_sql     text;
  v_changed int := 0;
  v_left    int;
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check
      from pg_policies
     where schemaname = 'public'
       and (qual ~ re or with_check ~ re)
  loop
    v_sql := format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    if p.qual is not null then
      v_sql := v_sql || format(' using (%s)', regexp_replace(p.qual, re, '(select \1)', 'g'));
    end if;
    if p.with_check is not null then
      v_sql := v_sql || format(' with check (%s)', regexp_replace(p.with_check, re, '(select \1)', 'g'));
    end if;
    execute v_sql;
    v_changed := v_changed + 1;
  end loop;

  select count(*) into v_left
    from pg_policies
   where schemaname = 'public'
     and (qual ~ re or with_check ~ re);
  if v_left <> 0 then
    raise exception 'S13: % public policies still carry a bare identity call after the rewrite', v_left;
  end if;

  raise notice 'S13: rewrote % public policies to InitPlan form', v_changed;
end
$rewrite$;
-- <<< INLINE 20260928100000_rls_initplan_wrap.sql <<<

-- >>> INLINE 20260928101000_hot_tenant_date_indexes.sql >>>
-- ============================================================================
-- S14 — (tenant_id, date) indexes on the tables every list view and report reads.
--
-- ─── WHY ─────────────────────────────────────────────────────────────────────
-- migrations-archive/0230_tenant_id_indexes.sql was written but never reached the
-- database that baseline.sql was dumped from: none of its 12 indexes are in baseline.sql
-- or in any later migration (checked 28 Sep 2026 with grep, and against the local replica's
-- pg_indexes). On top of that, the four hottest date-filtered tables have no index that
-- leads on tenant_id AND carries the date the app filters/sorts by:
--     leads     — every list orders by created_at            (only partial (tenant, created_at) ones exist)
--     invoices  — GST/ledger reports range on invoice_date    (only (tenant_id, status))
--     payments  — cash reports range on received_at           (only (tenant_id) and (received_at))
--     quotes    — lists order by created_date                 (only (tenant_id), (tenant_id, status))
--     lead_activities — no tenant_id index at all             (covered by 0230's index below)
--
-- Composite (tenant_id, <date> desc): tenant_id leads, so it serves the RLS tenant filter
-- AND the range/sort in one index, and still serves a plain tenant_id lookup. The existing
-- single-column tenant indexes (payments_tenant_idx, idx_quotes_tenant) become redundant;
-- they are NOT dropped here — dropping is a separate, measured decision.
--
-- From 0230, deliberately left out: inbound_emails_tenant_time_idx. Since 0230 was written
-- inbound_emails gained inbox/route/starred/pending-bill indexes that all lead on
-- (tenant_id, …, created_at desc) — another one would be pure write overhead.
--
-- ─── WHY NOT CONCURRENTLY HERE, AND WHAT TO DO ON PRODUCTION ─────────────────
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and migration runners
-- (supabase db push, and the begin … rollback regression test) wrap each file in one. So
-- this file uses plain CREATE INDEX IF NOT EXISTS, which takes a SHARE lock: writes to that
-- table wait until the build finishes; reads are not blocked. At today's row counts that is
-- milliseconds.
--
-- If a table has grown large by the time this ships (rule of thumb: > ~100k rows, or any
-- doubt), apply that statement MANUALLY first, one statement per call, outside a transaction:
--     create index concurrently if not exists leads_tenant_created_idx
--       on public.leads (tenant_id, created_at desc);
-- …then run this migration: IF NOT EXISTS makes the already-built ones no-ops. After a
-- CONCURRENTLY build, confirm it is valid (a failed concurrent build leaves an INVALID index
-- that IF NOT EXISTS would then silently skip):
--     select indexrelid::regclass from pg_index where not indisvalid;   -- expect 0 rows
-- ============================================================================

-- ─── Hot tables: (tenant_id, date) ──────────────────────────────────────────
create index if not exists leads_tenant_created_idx
  on public.leads (tenant_id, created_at desc);

create index if not exists invoices_tenant_invoice_date_idx
  on public.invoices (tenant_id, invoice_date desc);

create index if not exists payments_tenant_received_idx
  on public.payments (tenant_id, received_at desc);

create index if not exists quotes_tenant_created_date_idx
  on public.quotes (tenant_id, created_date desc);

-- ─── From migrations-archive/0230 (names kept, so a DB that did run 0230 no-ops) ──
create index if not exists lead_activities_tenant_time_idx
  on public.lead_activities (tenant_id, created_at desc);

create index if not exists project_sales_tenant_time_idx
  on public.project_sales (tenant_id, created_at desc);

create index if not exists project_tasks_tenant_time_idx
  on public.project_tasks (tenant_id, created_at desc);

create index if not exists project_milestones_tenant_time_idx
  on public.project_milestones (tenant_id, created_at desc);

create index if not exists project_payments_tenant_time_idx
  on public.project_payments (tenant_id, created_at desc);

create index if not exists project_labour_tenant_time_idx
  on public.project_labour (tenant_id, created_at desc);

create index if not exists emi_payments_tenant_time_idx
  on public.emi_payments (tenant_id, created_at desc);

create index if not exists business_loan_payments_tenant_time_idx
  on public.business_loan_payments (tenant_id, created_at desc);

create index if not exists employee_loan_repayments_tenant_time_idx
  on public.employee_loan_repayments (tenant_id, created_at desc);

create index if not exists leave_entries_tenant_time_idx
  on public.leave_entries (tenant_id, created_at desc);

create index if not exists renewal_email_log_tenant_time_idx
  on public.renewal_email_log (tenant_id, sent_at desc);

-- ─── VERIFY IN A SEPARATE RUN ───────────────────────────────────────────────
--   select tablename, indexname from pg_indexes
--    where schemaname = 'public'
--      and (indexname like '%\_tenant\_time\_idx' or indexname in (
--           'leads_tenant_created_idx','invoices_tenant_invoice_date_idx',
--           'payments_tenant_received_idx','quotes_tenant_created_date_idx'))
--    order by 1;
-- <<< INLINE 20260928101000_hot_tenant_date_indexes.sql <<<

-- ── Fixtures: two tenants; tenant 1 has owner / manager / repA / repB ─────────
insert into auth.users (id, email) values
  ('e1e1e1e1-0000-4000-8000-00000000000a', 's13-owner@example.test'),
  ('e1e1e1e1-0000-4000-8000-00000000000b', 's13-mgr@example.test'),
  ('e1e1e1e1-0000-4000-8000-00000000000c', 's13-repa@example.test'),
  ('e1e1e1e1-0000-4000-8000-00000000000d', 's13-repb@example.test'),
  ('e1e1e1e1-0000-4000-8000-00000000000e', 's13-other@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('eeeeeeee-0000-0000-0000-0000000000e1', 'S13 T1', 's13t1@example.in', '07', 'S13A'),
  ('eeeeeeee-0000-0000-0000-0000000000e2', 'S13 T2', 's13t2@example.in', '07', 'S13B');

insert into public.users (id, tenant_id, email, full_name, role, is_active, manager_id) values
  ('e1e1e1e1-0000-4000-8000-00000000000a', 'eeeeeeee-0000-0000-0000-0000000000e1',
   's13-owner@example.in', 'S13 Owner', 'owner', true, null),
  ('e1e1e1e1-0000-4000-8000-00000000000b', 'eeeeeeee-0000-0000-0000-0000000000e1',
   's13-mgr@example.in', 'S13 Manager', 'manager', true, null),
  ('e1e1e1e1-0000-4000-8000-00000000000c', 'eeeeeeee-0000-0000-0000-0000000000e1',
   's13-repa@example.in', 'S13 Rep A', 'sales', true, 'e1e1e1e1-0000-4000-8000-00000000000b'),
  ('e1e1e1e1-0000-4000-8000-00000000000d', 'eeeeeeee-0000-0000-0000-0000000000e1',
   's13-repb@example.in', 'S13 Rep B', 'sales', true, 'e1e1e1e1-0000-4000-8000-00000000000b'),
  ('e1e1e1e1-0000-4000-8000-00000000000e', 'eeeeeeee-0000-0000-0000-0000000000e2',
   's13-other@example.in', 'S13 Other Owner', 'owner', true, null);

insert into public.leads (id, tenant_id, company, owner_id) values
  ('L-S13-A',     'eeeeeeee-0000-0000-0000-0000000000e1', 'Rep A Co',     'e1e1e1e1-0000-4000-8000-00000000000c'),
  ('L-S13-B',     'eeeeeeee-0000-0000-0000-0000000000e1', 'Rep B Co',     'e1e1e1e1-0000-4000-8000-00000000000d'),
  ('L-S13-NULL',  'eeeeeeee-0000-0000-0000-0000000000e1', 'Unclaimed Co', null),
  ('L-S13-OTHER', 'eeeeeeee-0000-0000-0000-0000000000e2', 'Other Tenant', null);

-- ── 1. Shape: no bare identity call left in any public policy; indexes present ─
do $$
declare
  v_bare  int;
  v_names text;
  v_missing text;
begin
  /* The same "bare" definition as the migration: not already `( SELECT fn() …`. */
  select count(*), string_agg(tablename || '.' || policyname, ', ' order by 1)
    into v_bare, v_names
    from pg_policies
   where schemaname = 'public'
     and (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
         ~ '(?<![[:alnum:]_.])(?<!SELECT )((public\.)?current_tenant_id\(\)|(public\.)?current_customer_id\(\)|(public\.)?current_user_is_owner\(\)|auth\.uid\(\)|auth\.role\(\)|auth\.jwt\(\))';
  if v_bare <> 0 then
    raise exception 'FAIL S13: % public policies still call an identity function per row: %',
      v_bare, left(v_names, 400);
  end if;

  /* Wrapping must not have happened twice: `( SELECT ( SELECT …` would be a double wrap. */
  if exists (select 1 from pg_policies where schemaname = 'public'
              and (coalesce(qual,'') || coalesce(with_check,'')) ~ '\( SELECT \( SELECT') then
    raise exception 'FAIL S13: a policy was double-wrapped';
  end if;

  if exists (select 1 from pg_policies where schemaname = 'public'
              and (coalesce(qual,'') || coalesce(with_check,'')) ~ 'can_see_record\(') then
    raise exception 'FAIL S13: a policy still calls can_see_record(column) per row';
  end if;

  /* Nine hierarchy policies, every one still RESTRICTIVE — a permissive copy grants. */
  if (select count(*) from pg_policies where schemaname = 'public'
       and policyname like '%\_hierarchy\_%' and permissive = 'RESTRICTIVE') <> 9 then
    raise exception 'FAIL S13: expected 9 RESTRICTIVE hierarchy policies';
  end if;

  select string_agg(n, ', ') into v_missing
    from unnest(array[
      'leads_tenant_created_idx', 'invoices_tenant_invoice_date_idx',
      'payments_tenant_received_idx', 'quotes_tenant_created_date_idx',
      'lead_activities_tenant_time_idx', 'project_sales_tenant_time_idx',
      'project_tasks_tenant_time_idx', 'project_milestones_tenant_time_idx',
      'project_payments_tenant_time_idx', 'project_labour_tenant_time_idx',
      'emi_payments_tenant_time_idx', 'business_loan_payments_tenant_time_idx',
      'employee_loan_repayments_tenant_time_idx', 'leave_entries_tenant_time_idx',
      'renewal_email_log_tenant_time_idx']) as n
   where not exists (select 1 from pg_indexes i
                      where i.schemaname = 'public' and i.indexname = n
                        and i.indexdef like '%(tenant_id, %');
  if v_missing is not null then
    raise exception 'FAIL S14: missing (tenant_id, date) index: %', v_missing;
  end if;
end $$;

-- ── 2. Behaviour, under the REAL (migrated) policies — RLS only bites off-owner ─
set local role authenticated;

do $$
declare
  v_ids  text;
  v_cnt  int;
  v_plan text := '';
  r      record;
begin
  -- Rep A: own + unowned, never Rep B's, never the other tenant's.
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'e1e1e1e1-0000-4000-8000-00000000000c', 'role', 'authenticated')::text, true);
  select string_agg(id, ',' order by id) into v_ids from public.leads where id like 'L-S13-%';
  if v_ids is distinct from 'L-S13-A,L-S13-NULL' then
    raise exception 'FAIL rep A: expected own + unowned, got [%]', v_ids;
  end if;

  -- The plan: identity calls are InitPlans (evaluated once), not per-row filters.
  for r in execute 'explain (costs off) select id from public.leads' loop
    v_plan := v_plan || r."QUERY PLAN" || E'\n';
  end loop;
  if v_plan !~ 'InitPlan' then
    raise exception 'FAIL S13: no InitPlan in the leads plan:%', E'\n' || v_plan;
  end if;
  if v_plan ~ 'can_see_record' then
    raise exception 'FAIL S13: leads plan still calls can_see_record per row:%', E'\n' || v_plan;
  end if;

  -- Blind write on a peer's lead is still blocked; own write still allowed.
  update public.leads set company = 'HIJACKED' where id = 'L-S13-B';
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then raise exception 'FAIL blind write: rep A updated % of rep B''s rows', v_cnt; end if;
  update public.leads set company = 'Rep A Co (edited)' where id = 'L-S13-A';
  get diagnostics v_cnt = row_count;
  if v_cnt <> 1 then raise exception 'FAIL own write: rep A updated % own rows', v_cnt; end if;
  delete from public.leads where id = 'L-S13-B';
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then raise exception 'FAIL blind delete: rep A deleted % of rep B''s rows', v_cnt; end if;

  -- Rep B mirrors it.
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'e1e1e1e1-0000-4000-8000-00000000000d', 'role', 'authenticated')::text, true);
  select string_agg(id, ',' order by id) into v_ids from public.leads where id like 'L-S13-%';
  if v_ids is distinct from 'L-S13-B,L-S13-NULL' then
    raise exception 'FAIL rep B: expected own + unowned, got [%]', v_ids;
  end if;

  -- Manager: both reports + unowned.
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'e1e1e1e1-0000-4000-8000-00000000000b', 'role', 'authenticated')::text, true);
  select string_agg(id, ',' order by id) into v_ids from public.leads where id like 'L-S13-%';
  if v_ids is distinct from 'L-S13-A,L-S13-B,L-S13-NULL' then
    raise exception 'FAIL manager: expected A,B,NULL, got [%]', v_ids;
  end if;

  -- Owner: everything in their tenant by role — and nothing from the other tenant.
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'e1e1e1e1-0000-4000-8000-00000000000a', 'role', 'authenticated')::text, true);
  select string_agg(id, ',' order by id) into v_ids from public.leads where id like 'L-S13-%';
  if v_ids is distinct from 'L-S13-A,L-S13-B,L-S13-NULL' then
    raise exception 'FAIL owner: expected A,B,NULL (and not OTHER), got [%]', v_ids;
  end if;

  -- Other tenant's owner: only their own row. Tenant isolation survived the rewrite.
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'e1e1e1e1-0000-4000-8000-00000000000e', 'role', 'authenticated')::text, true);
  select string_agg(id, ',' order by id) into v_ids from public.leads where id like 'L-S13-%';
  if v_ids is distinct from 'L-S13-OTHER' then
    raise exception 'FAIL tenant isolation: tenant 2 owner saw [%]', v_ids;
  end if;
  update public.leads set company = 'CROSS-TENANT' where id = 'L-S13-A';
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then raise exception 'FAIL tenant isolation: cross-tenant update hit % rows', v_cnt; end if;

  -- No caller at all: nothing.
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  select count(*) into v_cnt from public.leads where id like 'L-S13-%';
  if v_cnt <> 0 then raise exception 'FAIL anonymous jwt: saw % leads', v_cnt; end if;

  raise notice 'PASS rls_initplan_and_hot_indexes';
end $$;

reset role;

select 'PASS' as rls_initplan_and_hot_indexes;

rollback;
