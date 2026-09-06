-- ============================================================================
--  Phase 1b · Table grants + service_role RLS bypass  — RUN AS `resellersos_migration`
-- ----------------------------------------------------------------------------
--  On Cloud SQL only a table's OWNER may GRANT on it / create a policy on it,
--  and the 118 public tables are owned by `resellersos_migration` (the role the
--  restore ran as). So the grants + per-table service_role policy run here, as
--  that owner. Run 01a (as postgres) FIRST — the roles must already exist.
--
--  RUN:  gcloud sql connect resellersos-db --user=resellersos_migration --database=resellersos --project=resellsubsos-prod
--        \i 01b-grants-and-policies.sql
--  (No passwords to fill in this file.)
--
--  service_role bypass: Supabase uses the BYPASSRLS attribute, which Cloud SQL
--  forbids. Same effect the supported way — a permissive ALL policy TO
--  service_role on every RLS table. Idempotent (drops+recreates). Reversible.
-- ============================================================================

\set ON_ERROR_STOP on

begin;

-- Reproduce Supabase's grant model: full privileges to the API roles, RLS (the
-- 159 policies) does the actual restriction. Faithful — not stricter, not looser.
grant all privileges on all tables    in schema public to anon, authenticated, service_role;
grant all privileges on all sequences in schema public to anon, authenticated, service_role;
grant execute on all functions        in schema public to anon, authenticated, service_role;

-- NOTE: default privileges for FUTURE objects are handled separately (see
-- README "future migrations") — resellersos_migration lacks CREATE on schema
-- public so it cannot set them, and they are not needed for the existing 118
-- tables, which are granted explicitly above.

-- service_role sees/writes every row (BYPASSRLS stand-in): one permissive policy
-- per RLS-enabled public table. Named zzz_ so it sorts last.
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname='public' and rowsecurity loop
    execute format('drop policy if exists zzz_service_role_all on public.%I', r.tablename);
    execute format('create policy zzz_service_role_all on public.%I as permissive for all to service_role using (true) with check (true)', r.tablename);
  end loop;
end $$;

commit;

-- Verify
select 'service_role policies' as check, count(*)::text as detail
  from pg_policies where schemaname='public' and policyname='zzz_service_role_all'
union all
select 'tables granted to service_role',
  count(distinct table_name)::text
  from information_schema.role_table_grants
  where table_schema='public' and grantee='service_role' and privilege_type='SELECT';
