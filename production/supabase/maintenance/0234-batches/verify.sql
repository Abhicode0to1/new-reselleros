-- 0234 verification — RUN THIS ON ITS OWN, AFTER both batches.
--
-- Never paste this into the same run as the DDL. The editor runs a pasted script
-- as one transaction, so these SELECTs would execute inside it, see the new
-- tables, and return rows — reporting success for a change that is about to roll
-- back. Alone, it can only tell you what is actually committed.

-- 1. Both tables exist? Expect 2 rows.
select table_name
  from information_schema.tables
 where table_schema = 'public'
   and table_name in ('vault_passwords', 'vault_access_log')
 order by table_name;

-- 2. The enum exists? Expect 1 row: vault_category.
select typname from pg_type where typname = 'vault_category';

-- 3. RLS actually ON? Expect relrowsecurity = true for BOTH.
-- This is the one worth checking rather than assuming: the tables can exist
-- with RLS off, and then every tenant can read every other tenant's passwords.
select relname, relrowsecurity
  from pg_class
 where relname in ('vault_passwords', 'vault_access_log')
 order by relname;

-- 4. Policies present? Expect vault_passwords = 4, vault_access_log = 2.
select tablename, count(*) as policies
  from pg_policies
 where schemaname = 'public'
   and tablename in ('vault_passwords', 'vault_access_log')
 group by tablename
 order by tablename;

-- 5. Right project? current_database() is 'postgres' on EVERY Supabase project,
-- so it cannot tell two apart. Use a row-count fingerprint instead.
select (select count(*) from public.customers)     as customers,
       (select count(*) from public.subscriptions) as subscriptions;
