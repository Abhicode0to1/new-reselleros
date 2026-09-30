-- R-037 (29 Sep 2026): can_see_record() is no longer callable without signing in.
--
-- ─── WHY ─────────────────────────────────────────────────────────────────────
-- 20260818150000_user_hierarchy_visibility.sql created can_see_record(uuid) as
-- SECURITY DEFINER and granted EXECUTE to anon, because RLS policies called it and
-- policies run as whoever is asking. 20260928100000_rls_initplan_wrap.sql (S13) inlined
-- its body into those policies — no policy calls it any more (checked: 0 rows in
-- pg_policies mention it). What remained was a definer function any anonymous visitor
-- could call through /rest/v1/rpc/can_see_record, and anon_default_privileges.test.sql
-- has failed ("FAIL 3") since the 28 Sep merge.
--
-- ─── WHY NOT DROP IT ─────────────────────────────────────────────────────────
-- src/lib/team/hierarchy-policy.test.ts reads its body from the migrations to prove the
-- UI and the database agree on who sees whose leads, and the generated types still
-- list it. Signed-in callers keep EXECUTE; only the unauthenticated grant goes.
--
-- Idempotent: revoking a privilege that is not held is a no-op.

revoke execute on function public.can_see_record(uuid) from public;
revoke execute on function public.can_see_record(uuid) from anon;
grant  execute on function public.can_see_record(uuid) to authenticated, service_role;
