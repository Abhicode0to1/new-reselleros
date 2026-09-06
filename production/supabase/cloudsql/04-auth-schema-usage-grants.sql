-- ============================================================================
--  Phase 1 fix · Let the app roles (and the RLS definer functions) USE schema auth
--  RUN AS `postgres`.
-- ----------------------------------------------------------------------------
--  Symptom (7 Sep 2026): a fully-logged-in user saw "No workspace". Every
--  tenant-scoped RLS policy is `tenant_id = public.current_tenant_id()`, and that
--  SECURITY DEFINER helper does `select tenant_id from users where id = auth.uid()`.
--  Calling current_tenant_id() over PostgREST returned:
--      403 · 42501 · permission denied for schema auth
--  i.e. the role executing the helper had no USAGE on schema `auth`, so `auth.uid()`
--  could not even be resolved — the policy errored and every table read came back
--  empty. Hosted Supabase ships these grants by default; the migration missed them.
--
--  Grant USAGE on schema auth + EXECUTE on the auth.* helpers to the app roles AND
--  to resellersos_migration (it owns current_tenant_id(), so the definer body runs
--  as it and must be able to call auth.uid()).
-- ============================================================================

grant usage on schema auth to anon, authenticated, service_role, resellersos_migration;

grant execute on function auth.uid()   to anon, authenticated, service_role, resellersos_migration;
grant execute on function auth.role()  to anon, authenticated, service_role, resellersos_migration;
grant execute on function auth.jwt()   to anon, authenticated, service_role, resellersos_migration;
grant execute on function auth.email() to anon, authenticated, service_role, resellersos_migration;

-- Belt-and-braces: anything else already in auth (GoTrue's own funcs) stays callable.
grant execute on all functions in schema auth to anon, authenticated, service_role, resellersos_migration;
