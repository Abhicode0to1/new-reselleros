-- anon gets nothing by default (27 Sep 2026, deep study S12).
--
-- baseline.sql carries Supabase's stock ALTER DEFAULT PRIVILEGES: every table, sequence and
-- function created by `postgres` in `public` is granted ALL to `anon` the moment it exists.
-- That is why the 27 Sep hardening (20260927100000) had to sweep 58 SECURITY DEFINER
-- functions anon could call — and why three migrations written the same afternoon
-- (unreconcile_bank_receipt, pay_salary, book_bank_txn_as_*) were anon-executable again the
-- moment they were applied. Their own NULL-tenant guards are what stood between an
-- unauthenticated caller and a salary payment. A sweep fixes today; a default fixes tomorrow.
--
-- What this does:
--   1. Default privileges: anon no longer receives anything on new functions, tables or
--      sequences. `authenticated` keeps its defaults (RLS decides what it sees); the app's
--      public routes all go through the service role, never the anon key.
--   2. Re-runs the definer-function sweep for everything created since the hardening.
--   3. `schema_one_off_fixes` — the only table with no RLS and no tenant_id — gets RLS and
--      loses its anon/authenticated grants. It is a migration marker table: deleting its
--      row would let a non-idempotent data shift run twice.
--
-- Not done here, on purpose: revoking anon's EXISTING table grants across the board. Every
-- table is behind RLS with policies TO authenticated / service_role, so anon reads nothing
-- today, and a blanket revoke would need a per-table audit of the public pages first.

-- ── 1. Defaults ──────────────────────────────────────────────────────────────
-- Only for the role applying migrations (postgres on prod and local). ALTER DEFAULT
-- PRIVILEGES FOR ROLE x needs to be x or its member; supabase_admin is neither, and its
-- defaults are not the ones baseline.sql set. The current-role form needs no name.
alter default privileges in schema public revoke all on functions from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
-- Postgres itself grants EXECUTE on every new function to PUBLIC (anon is a member of
-- PUBLIC), independent of the Supabase defaults above — removing anon's grant alone
-- changes nothing. That built-in grant is GLOBAL, and the docs are explicit that a
-- per-schema default cannot revoke a global one, so this one has no IN SCHEMA clause.
-- `authenticated` and `service_role` keep their explicit per-schema defaults, so app
-- code sees no difference; only PUBLIC/anon lose the free pass.
alter default privileges revoke execute on functions from public;
-- The stock grants were written FOR ROLE postgres explicitly; clear those too when we are
-- postgres (a no-op otherwise, guarded so a differently named migration role still applies).
do $$ begin
  if current_user = 'postgres' or pg_has_role(current_user, 'postgres', 'member') then
    execute 'alter default privileges for role postgres in schema public revoke all on functions from anon';
    execute 'alter default privileges for role postgres in schema public revoke all on tables from anon';
    execute 'alter default privileges for role postgres in schema public revoke all on sequences from anon';
    execute 'alter default privileges for role postgres revoke execute on functions from public';
  end if;
end $$;

-- ── 2. Sweep: definer functions created after the hardening ─────────────────
do $$
declare
  r record;
  v_policy_fns text[];
  v_n int := 0;
begin
  select coalesce(array_agg(distinct m[1]), '{}') into v_policy_fns
    from pg_policy pol,
         regexp_matches(
           coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' ||
           coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), ''),
           '(?:public\.)?([a-z_]+)\(', 'g') m;
  for r in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
       and has_function_privilege('anon', p.oid, 'EXECUTE')
  loop
    if r.proname = any (v_policy_fns) then continue; end if;
    execute format('revoke execute on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated, service_role', r.sig);
    v_n := v_n + 1;
  end loop;
  raise notice 'anon EXECUTE removed from % definer functions', v_n;
end $$;

-- ── 3. schema_one_off_fixes: server-only ─────────────────────────────────────
alter table public.schema_one_off_fixes enable row level security;
revoke all on public.schema_one_off_fixes from anon, authenticated;
drop policy if exists zzz_service_role_all on public.schema_one_off_fixes;
create policy zzz_service_role_all on public.schema_one_off_fixes
  as permissive for all to service_role using (true) with check (true);
