-- 0233 verification — RUN ON ITS OWN, AFTER both batches.
--
-- ONE statement. The Supabase editor shows only the LAST result when a script
-- has several, so a multi-statement verify hides every check but the final one
-- and looks like it passed.
--
-- Every row must say PASS.

select 'table exists'          as check,
       count(*)::text          as got,
       '1'                     as expected,
       case when count(*) = 1 then 'PASS' else 'FAIL — run batch-1-table.sql' end as verdict
  from information_schema.tables
 where table_schema = 'public' and table_name = 'access_credentials'

union all
-- Without RLS every tenant can read every other tenant's access register —
-- which is a list of who holds the keys to what. Counts only rows where
-- relrowsecurity is actually true.
select 'RLS enabled', count(*)::text, '1',
       case when count(*) = 1 then 'PASS' else 'FAIL — run batch-2-rls.sql' end
  from pg_class
 where relname = 'access_credentials' and relrowsecurity

union all
select 'policies', count(*)::text, '4',
       case when count(*) = 4 then 'PASS' else 'FAIL — run batch-2-rls.sql' end
  from pg_policies
 where schemaname = 'public' and tablename = 'access_credentials'

union all
-- The register stores NO secret — only where a credential lives and who holds
-- it. If a column with a secret-sounding name ever appears here, something has
-- gone wrong with the design, so it is worth asserting rather than trusting.
select 'no secret column', count(*)::text, '0',
       case when count(*) = 0 then 'PASS' else 'FAIL — see lib/access/credentials.ts' end
  from information_schema.columns
 where table_schema = 'public' and table_name = 'access_credentials'
   and (column_name like '%password%' or column_name like '%secret%'
        or column_name like '%token%' or column_name like '%ciphertext%');
