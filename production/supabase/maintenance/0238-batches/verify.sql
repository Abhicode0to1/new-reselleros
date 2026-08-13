-- 0238 verification — RUN ON ITS OWN, AFTER both batches.
-- ONE statement: the Supabase editor shows only the LAST result of a
-- multi-statement script, which already hid four checks once.

select 'email_log table'  as check, count(*)::text as got, '1' as need,
       case when count(*) = 1 then 'PASS' else 'RUN batch-1-table.sql' end as verdict
  from information_schema.tables
 where table_schema='public' and table_name='email_log'

union all
-- Counted, never assumed: the table can exist with RLS off, and then every
-- tenant can read who every other tenant has been emailing.
select 'RLS enabled', count(*)::text, '1',
       case when count(*) = 1 then 'PASS' else 'RUN batch-2-rls.sql' end
  from pg_class where relname='email_log' and relrowsecurity

union all
select 'select policy', count(*)::text, '1',
       case when count(*) = 1 then 'PASS' else 'RUN batch-2-rls.sql' end
  from pg_policies where schemaname='public' and tablename='email_log'

union all
-- No insert/update/delete policy is CORRECT. Rows are written by the server
-- with the service-role key; a log its own subject can edit proves nothing.
select 'no write policies', count(*)::text, '0',
       case when count(*) = 0 then 'PASS' else 'CHECK — the log is editable' end
  from pg_policies where schemaname='public' and tablename='email_log' and cmd <> 'SELECT'

union all
-- Bodies must never be stored. This log answers "did we try, when, what
-- happened" — it is not an archive of correspondence.
select 'no body column', count(*)::text, '0',
       case when count(*) = 0 then 'PASS' else 'CHECK — a body column exists' end
  from information_schema.columns
 where table_schema='public' and table_name='email_log'
   and column_name in ('body','html','text','content','attachments');
