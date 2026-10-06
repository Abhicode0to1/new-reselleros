-- ============================================================================
-- 10 (6 Oct 2026, R-165): let service_role run the functions that RLS policies call.
--
-- WHY
--   Staging, invoice PDF: the server read of `quotes` failed with
--   "permission denied for function hierarchy_sees_all" — so the PDF had no line items and
--   then crashed. 20260928100000_rls_initplan_wrap revoked these helpers from PUBLIC and
--   granted them to authenticated/anon only. On hosted Supabase service_role has BYPASSRLS
--   and never evaluates a policy; on Cloud SQL it does NOT, so every policy that names
--   `public` (quotes / leads / customers hierarchy policies) is evaluated for service_role
--   too, and the missing EXECUTE fails the WHOLE query — not just that policy.
--   Every server-side read of those tables (PDFs, emails, crons) has been failing since.
--
-- WHAT: for every function in schema public that any policy expression calls, grant EXECUTE
--   to service_role. Grants only; nothing is revoked, no data changes. Re-runnable.
--   Run as the function owner (resellersos_migration); prints what it granted.
-- ============================================================================
do $$
declare f record; n int := 0;
begin
  for f in
    select distinct p.oid, p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace and ns.nspname = 'public'
     where exists (
       select 1 from pg_policy pol
        where coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' ||
              coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
              ~ ('\m' || p.proname || '\(')
     )
       and not has_function_privilege('service_role', p.oid, 'execute')
  loop
    begin
      execute format('grant execute on function %s to service_role', f.sig);
      raise notice 'granted execute on % to service_role', f.sig;
      n := n + 1;
    exception when insufficient_privilege then
      raise notice 'SKIPPED % (not owner — run again as postgres)', f.sig;
    end;
  end loop;
  raise notice 'done: % grant(s)', n;
end $$;
