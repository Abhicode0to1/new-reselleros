-- Run ONCE per database as an admin (Cloud SQL: `postgres`), BEFORE the app uses Prisma.
-- Not a migration: it needs CREATEROLE and a password, and passwords never go in git.
--
--   psql "<admin url>" -v runtime_pw="'...'" -v jobs_pw="'...'" -f db/ops/10-runtime-roles.sql
--
-- app_runtime — the web app (Cloud Run `resellersos`). DATABASE_URL.
-- app_jobs    — background jobs only (separate Cloud Run service). JOBS_DATABASE_URL.
--
-- Both are members of `authenticated`, so the existing policies and table grants apply to
-- them exactly as they apply to a signed-in PostgREST user. Neither may own a table, be a
-- superuser, have BYPASSRLS, or be a member of service_role/anon — the last block refuses
-- to finish otherwise, and tests/isolation re-checks it on every run.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_runtime') then
    create role app_runtime login inherit nobypassrls nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_jobs') then
    create role app_jobs login inherit nobypassrls nocreatedb nocreaterole;
  end if;
end $$;

alter role app_runtime with password :runtime_pw;
alter role app_jobs    with password :jobs_pw;

grant authenticated to app_runtime, app_jobs;
grant usage on schema public, auth, storage to app_runtime, app_jobs;

-- A request that hangs must not hold a row lock forever (record_payment locks quotes).
alter role app_runtime set statement_timeout = '30s';
alter role app_jobs    set statement_timeout = '120s';
alter role app_runtime set idle_in_transaction_session_timeout = '60s';
alter role app_jobs    set idle_in_transaction_session_timeout = '60s';

do $$
declare bad text;
begin
  select string_agg(rolname, ', ') into bad from pg_roles
   where rolname in ('app_runtime', 'app_jobs') and (rolsuper or rolbypassrls);
  if bad is not null then raise exception 'unsafe role attributes: %', bad; end if;

  select string_agg(m.rolname || ' in ' || r.rolname, ', ') into bad
    from pg_auth_members am
    join pg_roles r on r.oid = am.roleid
    join pg_roles m on m.oid = am.member
   where m.rolname in ('app_runtime', 'app_jobs')
     and r.rolname not in ('authenticated');
  if bad is not null then raise exception 'unexpected role membership: %', bad; end if;

  if exists (select 1 from pg_class where relowner in
             (select oid from pg_roles where rolname in ('app_runtime', 'app_jobs'))) then
    raise exception 'app_runtime/app_jobs must not own any relation';
  end if;
end $$;
