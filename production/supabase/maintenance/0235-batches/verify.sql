-- 0235 verification — RUN ON ITS OWN, AFTER the batch.
--
-- ONE statement. The Supabase editor shows only the LAST result when a script
-- has several, so a multi-statement verify hides every check but the final one
-- and looks like it passed.
--
-- This is the migration that unblocks sending via Gmail. Without these columns
-- the app cannot know which transport a tenant uses or whose account sends, so
-- an OAuth connection alone changes nothing.
--
-- Every row must say PASS.

select 'tenants.email_provider'       as check,
       count(*)::text                 as got,
       '1'                            as expected,
       case when count(*) = 1 then 'PASS' else 'FAIL — run batch-1-columns.sql' end as verdict
  from information_schema.columns
 where table_schema = 'public' and table_name = 'tenants'
   and column_name = 'email_provider'

union all
select 'tenants.gmail_sender_user_id', count(*)::text, '1',
       case when count(*) = 1 then 'PASS' else 'FAIL — run batch-1-columns.sql' end
  from information_schema.columns
 where table_schema = 'public' and table_name = 'tenants'
   and column_name = 'gmail_sender_user_id'

union all
select 'user_google_tokens.scopes', count(*)::text, '1',
       case when count(*) = 1 then 'PASS' else 'FAIL — run batch-1-columns.sql' end
  from information_schema.columns
 where table_schema = 'public' and table_name = 'user_google_tokens'
   and column_name = 'scopes'

union all
-- Every existing tenant must default to 'resend'. Gmail reports no bounces, so
-- a tenant silently switched to it would have dead addresses fail invisibly
-- while the app recorded "sent".
select 'all tenants default to resend',
       count(*) filter (where email_provider = 'resend')::text,
       count(*)::text,
       case when count(*) = count(*) filter (where email_provider = 'resend')
            then 'PASS' else 'CHECK — some tenant is already on gmail' end
  from public.tenants

union all
-- The check constraint is what stops a typo like 'gmial' being stored and then
-- silently falling through to no transport at all.
select 'email_provider check constraint', count(*)::text, '1',
       case when count(*) >= 1 then 'PASS' else 'FAIL — constraint missing' end
  from information_schema.constraint_column_usage
 where table_schema = 'public' and table_name = 'tenants'
   and column_name = 'email_provider';
