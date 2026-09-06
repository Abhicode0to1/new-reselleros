-- ============================================================================
--  Phase 2 fix · Let GoTrue (Auth) and Storage migrate their own schemas
--  RUN AS `postgres`.
-- ----------------------------------------------------------------------------
--  Two things the service roles need, discovered on first boot (6 Sep 2026):
--   1. CREATE on the DATABASE — Storage's migrator creates/ensures its schema
--      and errored "permission denied for database resellersos" without it.
--   2. A default search_path pointing at their own schema — otherwise GoTrue/
--      Storage try to create their migration tables in `public` (no CREATE there)
--      → "permission denied for schema public".
--  (Auth also works via a ?search_path=auth on its connection URL; setting the
--  role default here too keeps it consistent and lets that URL hack be dropped.)
-- ============================================================================

grant create on database resellersos to supabase_auth_admin, supabase_storage_admin;

alter role supabase_auth_admin    set search_path = auth, public;
alter role supabase_storage_admin set search_path = storage, public;
