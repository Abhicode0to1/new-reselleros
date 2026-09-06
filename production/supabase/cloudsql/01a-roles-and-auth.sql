-- ============================================================================
--  Phase 1a · Roles, auth/storage schemas, auth.* helpers  — RUN AS `postgres`
--  (idempotent — safe to re-run; skips whatever already exists)
-- ----------------------------------------------------------------------------
--  Needs createrole / cross-schema rights (postgres has them, resellersos_app
--  does not). Table GRANTS + RLS policies live in 01b (run as resellersos_app,
--  the table owner) because on Cloud SQL only a table's owner may grant on it.
--
--  RUN:  gcloud sql connect resellersos-db --user=postgres --database=resellersos --project=resellsubsos-prod
--        \i 01a-roles-and-auth.sql
--  Fill the 3 passwords below first (private secrets note).
-- ============================================================================

\set ON_ERROR_STOP on
\set authenticator_pw   'CHANGE_ME_AUTHENTICATOR'
\set auth_admin_pw      'CHANGE_ME_AUTH_ADMIN'
\set storage_admin_pw   'CHANGE_ME_STORAGE_ADMIN'

begin;

-- 1. Extensions
create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

-- 2. Roles (create only if missing; passwords set via ALTER, which is idempotent)
do $$
begin
  if not exists (select 1 from pg_roles where rolname='anon')                   then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated')          then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='service_role')           then create role service_role nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator')          then create role authenticator login noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_auth_admin')    then create role supabase_auth_admin login noinherit createrole; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_storage_admin') then create role supabase_storage_admin login noinherit createrole; end if;
end $$;

alter role authenticator          with login noinherit password :'authenticator_pw';
alter role supabase_auth_admin    with login noinherit createrole password :'auth_admin_pw';
alter role supabase_storage_admin with login noinherit createrole password :'storage_admin_pw';

grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role, supabase_auth_admin, supabase_storage_admin to postgres;

-- 3. auth & storage schemas
create schema if not exists auth    authorization supabase_auth_admin;
create schema if not exists storage authorization supabase_storage_admin;
grant usage on schema auth to anon, authenticated, service_role, authenticator, resellersos_app, postgres;

-- 4. auth.* helpers (identical to Supabase)
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')) $$;
create or replace function auth.email() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')) $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;

alter function auth.uid()   owner to supabase_auth_admin;
alter function auth.role()  owner to supabase_auth_admin;
alter function auth.email() owner to supabase_auth_admin;
alter function auth.jwt()   owner to supabase_auth_admin;
grant execute on function auth.uid(), auth.role(), auth.email(), auth.jwt()
  to anon, authenticated, service_role, authenticator, resellersos_app, postgres;

-- 5. Public-schema USAGE + default privileges for postgres-created future objects
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;

commit;

-- Verify
select 'roles' as check, string_agg(rolname, ', ' order by rolname) as detail
  from pg_roles where rolname in ('anon','authenticated','service_role','authenticator','supabase_auth_admin','supabase_storage_admin')
union all
select 'auth.uid()', case when to_regprocedure('auth.uid()') is not null then 'OK' else 'MISSING' end
union all
select 'authenticator can switch to', string_agg(r2.rolname, ', ')
  from pg_auth_members m join pg_roles r on r.oid=m.member join pg_roles r2 on r2.oid=m.roleid
  where r.rolname='authenticator';
