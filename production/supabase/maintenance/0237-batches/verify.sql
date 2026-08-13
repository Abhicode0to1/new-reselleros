-- 0237 verification — RUN ON ITS OWN, AFTER the batch.
--
-- ONE statement. The Supabase editor shows only the LAST result when a script
-- has several, so a multi-statement verify hides every check but the final one
-- and looks like it passed.
--
-- Every row must say PASS.

select 'tenant_secrets.resend_api_key' as check,
       count(*)::text                  as got,
       '1'                             as expected,
       case when count(*) = 1 then 'PASS' else 'FAIL — run batch-1-columns.sql' end as verdict
  from information_schema.columns
 where table_schema = 'public' and table_name = 'tenant_secrets'
   and column_name = 'resend_api_key'

union all
select 'tenants.email_from_address', count(*)::text, '1',
       case when count(*) = 1 then 'PASS' else 'FAIL — run batch-1-columns.sql' end
  from information_schema.columns
 where table_schema = 'public' and table_name = 'tenants'
   and column_name = 'email_from_address'

union all
select 'tenants.email_from_name', count(*)::text, '1',
       case when count(*) = 1 then 'PASS' else 'FAIL — run batch-1-columns.sql' end
  from information_schema.columns
 where table_schema = 'public' and table_name = 'tenants'
   and column_name = 'email_from_name'

union all
-- The column must start EMPTY. A non-null value here before anyone has pasted a
-- key would mean something wrote to it outside the sealing path, and therefore
-- possibly in plaintext.
select 'resend_api_key starts empty', count(*)::text, '0',
       case when count(*) = 0 then 'PASS' else 'CHECK — a key is already stored' end
  from public.tenant_secrets
 where resend_api_key is not null;
