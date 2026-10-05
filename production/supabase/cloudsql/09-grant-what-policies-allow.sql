-- ============================================================================
-- 09 (5 Oct 2026): give `authenticated` / `anon` the table privileges their RLS policies
-- already describe — and nothing more.
--
-- WHY
--   Staging, /subscriptions: "403 Forbidden on GET /rest/v1/customer_contacts". The table has
--   select/insert/update/delete policies for signed-in users, but `authenticated` has no SELECT
--   privilege on it at all. 30 public tables were in that state. They were all created by
--   migrations written the hosted-Supabase way, where default privileges hand every new table to
--   authenticated/anon; on Cloud SQL those defaults were deferred (01b), so a migration without
--   an explicit GRANT leaves the table unreadable however correct its policies are.
--
-- WHAT IT DOES
--   For every public table with RLS on, for every policy that applies to `authenticated`, `anon`
--   or PUBLIC, grant exactly the command(s) that policy covers (SELECT / INSERT / UPDATE /
--   DELETE; ALL = the four). A table with only service_role policies gets nothing — those are
--   server-only on purpose (rate_limit_buckets, email_verifications, …). RLS still decides which
--   ROWS anyone sees; this only lets the policies be reached.
--
--   Safe to re-run: GRANT is idempotent. Prints every grant it makes (NOTICE).
--   Run as the table owner (resellersos_migration):
--     gcloud sql import sql <instance> gs://…/09-grant-what-policies-allow.sql --database=resellersos --user=resellersos_migration
-- ============================================================================
do $$
declare
  rec record;
  priv text;
  n int := 0;
begin
  for rec in
    select c.oid, c.relname, p.polcmd, r.rolname
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
      cross join lateral (
        select case when x = 0 then 'public' else (select rolname from pg_roles where oid = x) end as rolname
          from unnest(p.polroles) as x
      ) r
     where ns.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
       and r.rolname in ('authenticated', 'anon', 'public')
  loop
    priv := case rec.polcmd when 'r' then 'select' when 'a' then 'insert' when 'w' then 'update' when 'd' then 'delete' else 'select, insert, update, delete' end;
    -- PUBLIC policies are meant for signed-in users here; give them to authenticated only.
    if rec.rolname = 'public' then rec.rolname := 'authenticated'; end if;
    if priv = 'select, insert, update, delete' or not has_table_privilege(rec.rolname, rec.oid, upper(priv)) then
      begin
        execute format('grant %s on public.%I to %I', priv, rec.relname, rec.rolname);
        raise notice 'granted % on % to %', priv, rec.relname, rec.rolname;
        n := n + 1;
        -- An INSERT on a table with a serial/identity column also needs its sequence.
        if priv like '%insert%' then
          for priv in
            select format('grant usage, select on sequence %s to %I', s.oid::regclass, rec.rolname)
              from pg_class s join pg_depend d on d.objid = s.oid and d.deptype in ('a', 'i')
             where s.relkind = 'S' and d.refobjid = rec.oid
          loop
            execute priv;
          end loop;
        end if;
      exception when insufficient_privilege then
        -- Not the owner (e.g. the Academy tables belong to postgres) — say so, carry on.
        raise notice 'SKIPPED % on % (not owner — run this file again as postgres for it)', priv, rec.relname;
      end;
    end if;
  end loop;
  raise notice 'done: % grant(s)', n;
end $$;
