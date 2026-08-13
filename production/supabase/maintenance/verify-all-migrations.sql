-- Verify 0233 / 0234 / 0235 / 0237 in ONE run.
--
-- Written because I sent three separate files all named verify.sql and two named
-- batch-1-columns.sql. On a file card they are indistinguishable, so there was
-- no way to know which had been run. This replaces all of them: one statement,
-- one result, every migration.
--
-- ONE statement on purpose — the Supabase editor shows only the LAST result of a
-- multi-statement script, which already hid four checks once.
--
-- Run it ALONE, never in the same run as DDL.
--
-- Read the `verdict` column. Anything not PASS names the file to run.

select * from (
  -- ── 0234 vault ────────────────────────────────────────────────────────────
  select 1 as ord, '0234' as migration, 'vault tables' as check,
         count(*)::text as got, '2' as need,
         case when count(*) = 2 then 'PASS' else 'RUN 0234-batches/batch-1-tables.sql' end as verdict
    from information_schema.tables
   where table_schema='public' and table_name in ('vault_passwords','vault_access_log')

  union all
  select 2, '0234', 'vault RLS on', count(*)::text, '2',
         case when count(*) = 2 then 'PASS' else 'RUN 0234-batches/batch-2-rls.sql' end
    from pg_class
   where relname in ('vault_passwords','vault_access_log') and relrowsecurity

  -- ── 0235 email provider — the one blocking Gmail ──────────────────────────
  union all
  select 3, '0235', 'tenants.email_provider', count(*)::text, '1',
         case when count(*) = 1 then 'PASS' else 'RUN 0235-batches/batch-1-columns.sql' end
    from information_schema.columns
   where table_schema='public' and table_name='tenants' and column_name='email_provider'

  union all
  select 4, '0235', 'tenants.gmail_sender_user_id', count(*)::text, '1',
         case when count(*) = 1 then 'PASS' else 'RUN 0235-batches/batch-1-columns.sql' end
    from information_schema.columns
   where table_schema='public' and table_name='tenants' and column_name='gmail_sender_user_id'

  union all
  select 5, '0235', 'user_google_tokens.scopes', count(*)::text, '1',
         case when count(*) = 1 then 'PASS' else 'RUN 0235-batches/batch-1-columns.sql' end
    from information_schema.columns
   where table_schema='public' and table_name='user_google_tokens' and column_name='scopes'

  -- ── 0237 per-tenant Resend ────────────────────────────────────────────────
  union all
  select 6, '0237', 'tenant_secrets.resend_api_key', count(*)::text, '1',
         case when count(*) = 1 then 'PASS' else 'RUN 0237-batches/batch-1-columns.sql' end
    from information_schema.columns
   where table_schema='public' and table_name='tenant_secrets' and column_name='resend_api_key'

  union all
  select 7, '0237', 'tenants.email_from_address', count(*)::text, '1',
         case when count(*) = 1 then 'PASS' else 'RUN 0237-batches/batch-1-columns.sql' end
    from information_schema.columns
   where table_schema='public' and table_name='tenants' and column_name='email_from_address'

  -- ── 0233 access register ──────────────────────────────────────────────────
  union all
  select 8, '0233', 'access_credentials table', count(*)::text, '1',
         case when count(*) = 1 then 'PASS' else 'RUN 0233-batches/batch-1-table.sql' end
    from information_schema.tables
   where table_schema='public' and table_name='access_credentials'

  union all
  select 9, '0233', 'access_credentials RLS on', count(*)::text, '1',
         case when count(*) = 1 then 'PASS' else 'RUN 0233-batches/batch-2-rls.sql' end
    from pg_class
   where relname='access_credentials' and relrowsecurity

  -- ── Sanity, not a migration ───────────────────────────────────────────────
  -- Every tenant must still default to resend. Gmail reports no bounces, so a
  -- tenant silently on it would have dead addresses fail while the app recorded
  -- "sent". Returns INFO when the column does not exist yet.
  union all
  select 10, '0235', 'tenants not on gmail',
         coalesce((select count(*) filter (where email_provider = 'gmail')::text
                     from public.tenants), 'n/a'),
         '0',
         case when not exists (select 1 from information_schema.columns
                                where table_schema='public' and table_name='tenants'
                                  and column_name='email_provider')
              then 'INFO — column not created yet'
              when (select count(*) from public.tenants where email_provider='gmail') = 0
              then 'PASS'
              else 'CHECK — a tenant is already on gmail' end
) t order by ord;
