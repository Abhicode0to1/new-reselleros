-- 0239 — restore EXECUTE on the two functions every RLS policy depends on
--
-- SYMPTOM
-- -------
-- Nobody can use the app. Signed-in users see the shell but every page reads
-- empty: 0 customers, 0 subscriptions, 0 team members, the user chip stuck on
-- "Loading…" forever, and new logins never complete. One page — /subscriptions —
-- shows the raw cause instead of an empty state:
--
--     permission denied for function current_customer_id
--
-- Everywhere else the same failure is swallowed and rendered as "no data",
-- which is why this looked like deleted data rather than a broken permission.
--
-- CAUSE
-- -----
-- public.current_tenant_id() is referenced by 335 RLS policies and
-- public.current_customer_id() by 10. Both are SECURITY DEFINER helpers.
--
-- current_customer_id() was granted explicitly in 0016. current_tenant_id() was
-- NEVER granted in any migration — it has run for the whole life of this project
-- on the EXECUTE that Postgres gives PUBLIC by default when a function is
-- created. That default is not a guarantee; it disappears the moment anyone runs
--
--     revoke execute on all functions in schema public from public;
--
-- which is a standard hardening step and exactly the kind of thing that gets run
-- against a production database without a migration behind it. Production
-- reporting "permission denied" for current_customer_id — which DOES have an
-- explicit grant — is the evidence that grants have been lost there, and if the
-- explicit one is gone the implicit one certainly is.
--
-- When current_tenant_id() cannot execute, all 335 policies fail closed. RLS
-- returning zero rows is indistinguishable, from the app's side, from a tenant
-- that owns nothing. That is the whole outage.
--
-- WHY THIS IS A MIGRATION AND NOT A CONSOLE FIX
-- ---------------------------------------------
-- Because it already happened once invisibly. A grant applied by hand in the
-- dashboard leaves no record, so the next environment — or the next restore —
-- comes up broken again with no clue why. CLAUDE.md §17.
--
-- ⚠️  RUN THE DDL ALONE. Do NOT paste the verification SELECT in the same run:
-- inside the same uncommitted transaction it will report success for a change
-- that is about to roll back. Verify in a SEPARATE run (§25.6).

begin;

-- `authenticated` is the role every signed-in app user carries. Granted
-- explicitly rather than relying on PUBLIC, so a future blanket REVOKE cannot
-- silently take the app down again.
grant execute on function public.current_tenant_id()   to authenticated;
grant execute on function public.current_customer_id() to authenticated;

-- The customer portal reaches Postgres with the anon key and a customer session,
-- so its helper must be executable by anon too. current_tenant_id is deliberately
-- NOT granted to anon: nothing unauthenticated has a tenant, and widening it
-- would hand an anonymous caller the ability to probe tenant-scoped policies.
grant execute on function public.current_customer_id() to anon;

comment on function public.current_tenant_id() is
  'Returns tenant_id for the authenticated user. Used in 335 RLS policies. EXECUTE is granted explicitly in 0239 — do NOT rely on the default PUBLIC grant, losing it takes the entire app down and presents as empty data rather than an error.';

commit;

-- ── VERIFY — run this SEPARATELY, after the commit above ────────────────────
--
-- select p.proname,
--        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_ok,
--        has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_ok
-- from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public'
--   and p.proname in ('current_tenant_id','current_customer_id');
--
-- Expected:
--   current_tenant_id     authenticated_ok = true,  anon_ok = false
--   current_customer_id   authenticated_ok = true,  anon_ok = true
