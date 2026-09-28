-- ============================================================================
-- Close three holes found in the 27 Sep 2026 security audit.
--
-- 1. A signed-in user with no `users` row yet (Google sign-in waiting on /welcome, or a
--    join request awaiting approval) could INSERT their own `users` row with any
--    tenant_id and role = 'owner': policy users_signup_insert only checks id = auth.uid(),
--    and `authenticated` holds INSERT on `role` and `tenant_id`. Every legitimate insert
--    into `users` is made either by the server (service role) or inside a SECURITY DEFINER
--    RPC (merge_stranded_user_into_tenant, set_my_employee) — never by the browser role
--    directly. The trigger looks at the DATABASE role (`current_user`), which is the
--    function owner inside a definer RPC and `authenticated` / `anon` for a direct
--    PostgREST write, so the RPCs keep working and the direct write is refused. The policy
--    is left as is (a colleague's area); the trigger fires first.
--
-- 2. Seventeen SECURITY DEFINER RPCs guarded their tenant with
--        if v_tenant is not null and row.tenant_id is distinct from v_tenant then raise
--    which is no guard at all when v_tenant is NULL — exactly the anon and no-users-row
--    cases. Rewritten in place so a NULL tenant raises when the JWT role is anon or
--    authenticated. A session with no JWT at all (psql, migrations, the SQL tests) is not
--    a PostgREST caller and is left alone, as before. All seventeen are called from the
--    browser only (checked: no admin-client caller).
--
-- 3. EXECUTE on most SECURITY DEFINER functions in `public` was still granted to PUBLIC,
--    so `anon` could call refund_payment, reopen_quote, reconcile_bank_txn,
--    resolve_or_create_contact(p_tenant, …) and ~58 others. For every definer function
--    anon can currently execute: revoke from PUBLIC and anon, re-grant to authenticated
--    and service_role (which PUBLIC had implied). Functions already locked down (e.g.
--    export_snapshots_for_offsite, service_role only) are not touched. Functions that RLS
--    policies evaluate (current_tenant_id, current_user_is_owner, can_see_record, …) keep
--    what they have, since a policy runs as the querying role. Every public API route uses
--    the admin client, so no public flow needs anon EXECUTE (checked: zero rpc() calls from
--    (auth), (marketing) or site/ browser code).
-- ============================================================================

-- ── 1. users: no direct browser-role inserts ────────────────────────────────
create or replace function public.tg_users_insert_server_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('authenticated', 'anon') then
    raise exception 'Team members are added through an invite or an approved join request.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists trg_users_insert_server_only on public.users;
create trigger trg_users_insert_server_only
  before insert on public.users
  for each row execute function public.tg_users_insert_server_only();

-- ── 2. Weak tenant checks: a NULL tenant from a PostgREST caller now raises ─
do $$
declare
  r record;
  v_def text;
  v_new text;
  v_fixed int := 0;
begin
  for r in
    select p.oid, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
       and pg_get_functiondef(p.oid) ~* 'if v_tenant is not null and |coalesce\(auth\.role\(\), ''''\) <> ''service_role'''
  loop
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(
      v_def,
      'if v_tenant is not null and (.*?) then',
      'if (v_tenant is null and coalesce(auth.role(), '''') in (''anon'', ''authenticated'')) or (v_tenant is not null and \1) then',
      'gi');
    /* An earlier draft of this migration wrote `<> 'service_role'` here; fold that into the
       same final form so re-running is idempotent. */
    v_new := replace(v_new,
      'coalesce(auth.role(), '''') <> ''service_role''',
      'coalesce(auth.role(), '''') in (''anon'', ''authenticated'')');
    if v_new = v_def then
      raise exception 'Could not rewrite the tenant check in %', r.proname;
    end if;
    execute v_new;
    v_fixed := v_fixed + 1;
  end loop;
  raise notice 'tenant checks rewritten: %', v_fixed;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
       and pg_get_functiondef(p.oid) ~* 'if v_tenant is not null and '
  ) then
    raise exception 'A weak tenant check survived the rewrite';
  end if;
end $$;

-- ── 3. EXECUTE on definer functions: never anon ─────────────────────────────
do $$
declare
  r record;
  v_policy_fns text[];
  v_n int := 0;
begin
  /* Functions any RLS policy calls must stay callable by whoever runs the query. */
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

/* Takes the tenant id as an argument and trusts it; only the leads auto-link trigger
   (SECURITY DEFINER, runs as owner) needs it. Nobody from the browser does. */
revoke execute on function public.resolve_or_create_contact(uuid, text, text, text, text) from public, anon, authenticated;
