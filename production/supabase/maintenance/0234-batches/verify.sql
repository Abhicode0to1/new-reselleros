-- 0234 verification — RUN THIS ON ITS OWN, AFTER both batches.
--
-- ONE statement on purpose. The Supabase editor shows only the LAST result when
-- a script contains several statements, so the previous version of this file
-- silently reported just the project fingerprint and hid all four real checks.
-- A verification you cannot read is worse than none: it looks like it passed.
--
-- Never paste this into the same run as the DDL either. It would execute inside
-- the uncommitted transaction, see the new tables, and report success for a
-- change that is about to roll back.
--
-- Every row must say PASS.

select 'tables exist'        as check,
       count(*)::text        as got,
       '2'                   as expected,
       case when count(*) = 2 then 'PASS' else 'FAIL — run batch-1-tables.sql' end as verdict
  from information_schema.tables
 where table_schema = 'public'
   and table_name in ('vault_passwords', 'vault_access_log')

union all
select 'enum vault_category', count(*)::text, '1',
       case when count(*) = 1 then 'PASS' else 'FAIL — run batch-1-tables.sql' end
  from pg_type where typname = 'vault_category'

union all
-- The check worth having. Both tables can exist with RLS OFF, and then every
-- tenant can read every other tenant's stored admin passwords. Counts only rows
-- where relrowsecurity is actually true.
select 'RLS enabled', count(*)::text, '2',
       case when count(*) = 2 then 'PASS' else 'FAIL — run batch-2-rls.sql' end
  from pg_class
 where relname in ('vault_passwords', 'vault_access_log')
   and relrowsecurity

union all
select 'policies', count(*)::text, '6',
       case when count(*) = 6 then 'PASS' else 'FAIL — run batch-2-rls.sql' end
  from pg_policies
 where schemaname = 'public'
   and tablename in ('vault_passwords', 'vault_access_log')

union all
-- Project fingerprint. current_database() is 'postgres' on EVERY Supabase
-- project, so it cannot tell two apart; a row count can.
select 'project (customers)', (select count(*) from public.customers)::text,
       '~56', 'INFO';
