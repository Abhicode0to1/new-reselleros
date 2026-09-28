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
