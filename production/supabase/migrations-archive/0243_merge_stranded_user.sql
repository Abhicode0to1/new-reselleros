-- ============================================================================
-- 0243 — merge_stranded_user_into_tenant(): claim a colleague who landed wrong
-- ============================================================================
--
-- ─── WHY THIS IS THE MOST IMPORTANT HALF OF THE FIX ─────────────────────────
-- 0242 stops NEW accidental tenants. It does nothing for the ones already here.
-- As of 14 Aug 2026 this database holds 24 auth accounts and only 11 profiles:
-- thirteen people can authenticate and have no workspace at all, and two more sit
-- in private tenants they created by mistake. There is currently no supported way
-- to move any of them, which is exactly why the mistake has been permanent.
--
-- Prevention alone is never enough, because prevention is never perfect. What
-- makes a class of mistake stop mattering is that fixing it becomes cheap.
--
-- ─── WHAT IT REFUSES TO DO, AND WHY THAT IS THE POINT ───────────────────────
-- It will NOT touch a tenant that holds business data. Not even to move the user
-- out of it — because moving the last user out of a tenant that still has
-- customers leaves those customers with nobody who can sign in and see them. The
-- data would not be deleted; it would become unreachable, which for an operator is
-- the same thing and is harder to notice. That is precisely the shape of the bug
-- this whole migration set exists to answer, and it would be absurd to recreate it
-- inside the repair tool.
--
-- So: empty tenant → user moved, tenant deleted, one click. Tenant with data →
-- the whole call is refused with the counts and a next step (CLAUDE.md §24). The
-- second case needs a decision from a human about the data, and this function is
-- not the place to make it.
--
-- ─── WHY THE EMPTINESS TEST IS FAIL-SAFE ────────────────────────────────────
-- It counts every `public` table carrying a tenant_id EXCEPT a short, explicit
-- list of bookkeeping tables. It is deliberately not the other way round. A table
-- added next month is counted by default, so the worst a future migration can
-- cause is a refusal to delete something deletable — never a delete of something
-- that mattered. Fail-safe means the unknown case is the safe case.
--
-- ─── HOW TO RUN (CLAUDE.md §25.6) ───────────────────────────────────────────
-- One batch at a time; the verify block is a SEPARATE run.
-- ============================================================================

-- ───────────────────────────────────────────────────────────────────────────
-- BATCH 1 · The function
-- ───────────────────────────────────────────────────────────────────────────
begin;

create or replace function public.merge_stranded_user_into_tenant(
  p_email     text,
  p_tenant_id uuid,
  p_role      public.user_role default 'support'
)
returns jsonb
language plpgsql
security definer
-- auth is on the path because the whole point is to find people who exist in
-- auth.users and nowhere else.
set search_path = public, auth
as $$
declare
  v_email        text := lower(btrim(p_email));
  v_caller_tid   uuid;
  v_caller_role  public.user_role;
  v_dest_name    text;
  v_auth_id      uuid;
  v_auth_name    text;
  v_old_tid      uuid;
  v_old_name     text;
  v_old_users    int;
  v_sql          text;
  v_holdings     jsonb;
  v_rows         bigint;
  v_action       text;
  v_deleted      boolean := false;
begin
  -- ── 1. The caller must own the destination workspace ────────────────────
  select u.tenant_id, u.role
    into v_caller_tid, v_caller_role
    from public.users u
   where u.id = auth.uid();

  if v_caller_tid is null then
    raise exception
      'You are not signed in to a workspace, so there is nothing to claim this person into. Sign in again and reopen Team.'
      using errcode = '42501';
  end if;

  if v_caller_tid <> p_tenant_id or v_caller_role <> 'owner' then
    raise exception
      'Only the owner of a workspace can claim someone into it. Ask your workspace owner to open Team → Claim a colleague.'
      using errcode = '42501';
  end if;

  select t.name into v_dest_name from public.tenants t where t.id = p_tenant_id;

  -- ── 2. Do they have an account at all? ──────────────────────────────────
  select au.id,
         coalesce(
           nullif(btrim(au.raw_user_meta_data ->> 'full_name'), ''),
           nullif(btrim(au.raw_user_meta_data ->> 'name'), ''),
           split_part(au.email, '@', 1)
         )
    into v_auth_id, v_auth_name
    from auth.users au
   where lower(au.email) = v_email
   limit 1;

  if v_auth_id is null then
    raise exception
      'No account exists for %. Send them an invite from Team → Invite teammate using this exact address, ask them to sign in once, then claim them.',
      v_email
      using errcode = 'P0002';
  end if;

  -- ── 3. Where are they now? ──────────────────────────────────────────────
  select u.tenant_id into v_old_tid
    from public.users u
   where u.id = v_auth_id;

  -- 3a. Already here. Only the role may need correcting.
  if v_old_tid = p_tenant_id then
    update public.users set role = p_role where id = v_auth_id and role <> p_role;
    v_action := case when found then 'role_updated' else 'already_member' end;

  -- 3b. Truly stranded: an auth account with no profile anywhere. This is the
  --     thirteen. Nothing to move and nothing to delete — just give them a home.
  elsif v_old_tid is null then
    insert into public.users (id, tenant_id, email, full_name, initials, role, color)
    values (
      v_auth_id, p_tenant_id, v_email, v_auth_name,
      upper(left(regexp_replace(coalesce(v_auth_name, v_email), '[^A-Za-z]', '', 'g'), 2)),
      p_role, 'indigo'
    );
    v_action := 'attached';

  -- 3c. They are sitting in another tenant.
  else
    select t.name, (select count(*) from public.users u2 where u2.tenant_id = t.id)
      into v_old_name, v_old_users
      from public.tenants t where t.id = v_old_tid;

    -- A workspace with other people in it is somebody's real company, not a
    -- stray. Refuse before looking at data — this tool is for accidents.
    if v_old_users > 1 then
      raise exception
        'Cannot claim %: they belong to "%", which has % people in it. That is a separate company, not an accidental workspace. If it really should be merged, that is a platform-admin job.',
        v_email, v_old_name, v_old_users
        using errcode = '23505';
    end if;

    -- Count everything that is not bookkeeping. Fail-safe: unlisted table = data.
    select string_agg(
             format('select %L::text as tbl, count(*)::bigint as n from public.%I where tenant_id = %L',
                    c.table_name, c.table_name, v_old_tid),
             ' union all ')
      into v_sql
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema
       and t.table_name   = c.table_name
       and t.table_type   = 'BASE TABLE'
     where c.table_schema = 'public'
       and c.column_name  = 'tenant_id'
       and c.table_name not in (
             -- Bookkeeping only. None of these is a thing an operator would
             -- mourn, and all of them cascade with the tenant anyway.
             'users', 'activity_log', 'team_invites', 'tenant_secrets',
             'document_series', 'customer_number_seq', 'user_google_tokens',
             'tenant_domains', 'join_requests', 'email_log', 'api_keys'
           );

    execute format(
      'select coalesce(jsonb_object_agg(tbl, n) filter (where n > 0), ''{}''::jsonb),
              coalesce(sum(n), 0) from (%s) s', v_sql)
      into v_holdings, v_rows;

    if v_rows > 0 then
      raise exception
        'Cannot claim %: their workspace "%" still holds % records (%). Moving them out would leave that data with no one who can sign in and see it. Move or export the data first — this tool only clears empty workspaces.',
        v_email, v_old_name, v_rows, v_holdings::text
        using errcode = '23503';
    end if;

    update public.users
       set tenant_id = p_tenant_id,
           role      = p_role,
           email     = v_email
     where id = v_auth_id;

    -- Empty, and now nobody is in it. 78 of 80 tenant FKs cascade.
    delete from public.tenants where id = v_old_tid;
    v_deleted := true;
    v_action  := 'moved';
  end if;

  -- ── 4. Any open request from this person is now settled ─────────────────
  update public.join_requests
     set status = 'approved', decided_at = now(), decided_by = auth.uid()
   where tenant_id = p_tenant_id
     and lower(email) = v_email
     and status = 'pending_approval';

  -- ── 5. Visible in the destination workspace, not just in a server log ───
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label)
  values (
    p_tenant_id, auth.uid(), v_action, 'user', v_auth_id::text,
    format('Claimed %s into %s as %s%s',
           v_email, coalesce(v_dest_name, 'this workspace'), p_role,
           case when v_deleted then format(' (removed empty workspace "%s")', v_old_name) else '' end)
  );

  return jsonb_build_object(
    'action',          v_action,
    'email',           v_email,
    'full_name',       v_auth_name,
    'auth_user_id',    v_auth_id,
    'role',            p_role,
    'tenant_id',       p_tenant_id,
    'tenant_name',     v_dest_name,
    'old_tenant_name', v_old_name,
    'old_tenant_deleted', v_deleted
  );
end;
$$;

comment on function public.merge_stranded_user_into_tenant(text, uuid, public.user_role) is
  'Owner-only. Attaches an auth account to the caller''s tenant and deletes the workspace it came from ONLY when that workspace is empty of business data. Refuses (does not partially apply) when the old workspace holds records or holds other people.';

revoke all on function public.merge_stranded_user_into_tenant(text, uuid, public.user_role) from public, anon;
grant execute on function public.merge_stranded_user_into_tenant(text, uuid, public.user_role) to authenticated;

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- BATCH 2 · Read-side helper: who is stranded right now?
--
-- The owner cannot see auth.users, and should not be able to. This returns the
-- one fact the Team page needs — "these people can sign in and have nowhere to
-- go" — without exposing the auth schema. Deliberately no tenant filter on the
-- input: strandedness is the absence of a tenant.
-- ───────────────────────────────────────────────────────────────────────────
begin;

create or replace function public.list_stranded_auth_users()
returns table (email text, full_name text, created_at timestamptz, last_sign_in_at timestamptz)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner') then
    raise exception 'Only a workspace owner can see this.' using errcode = '42501';
  end if;

  return query
    select au.email::text,
           coalesce(
             nullif(btrim(au.raw_user_meta_data ->> 'full_name'), ''),
             nullif(btrim(au.raw_user_meta_data ->> 'name'), ''),
             split_part(au.email, '@', 1)
           )::text,
           au.created_at,
           au.last_sign_in_at
      from auth.users au
     where not exists (select 1 from public.users u where u.id = au.id)
       and au.email is not null
     order by au.last_sign_in_at desc nulls last, au.created_at desc;
end;
$$;

comment on function public.list_stranded_auth_users() is
  'Owner-only. Auth accounts with no public.users row — people who can sign in and land nowhere. Exposes email and name only, never the auth row itself.';

revoke all on function public.list_stranded_auth_users() from public, anon;
grant execute on function public.list_stranded_auth_users() to authenticated;

commit;


-- ============================================================================
-- VERIFY — RUN THIS AS A SEPARATE EDITOR RUN
--
-- ─── GUARDS 1 AND 2 ARE PROVEN, NOT ASSUMED (14 Aug 2026) ───────────────────
-- 0241 shipped with its refusal paths untested because the SQL editor has no
-- auth.uid(), so every call stopped at the identity guard. That is avoidable —
-- impersonate inside a transaction and ask for something that must fail:
--
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<an owner uuid>"}';
--   select public.merge_stranded_user_into_tenant('nobody@example.com',
--            '<that owner''s tenant uuid>', 'support');
--   commit;
--
-- Run against this database with Pardeep's uuid, it returned:
--
--   ERROR: P0002: No account exists for nobody@example.com. Send them an invite
--   from Team → Invite teammate using this exact address, ask them to sign in
--   once, then claim them.
--   CONTEXT: PL/pgSQL function merge_stranded_user_into_tenant(...) line 51 at RAISE
--
-- The error IS the pass: reaching line 51 means guard 1 (owner of this tenant)
-- was satisfied and guard 2 rejected the unknown account, and the raise aborted
-- the transaction before any write. A bogus email keeps the probe safe to run
-- against production — it cannot reach the branches that move or delete anything.
--
-- STILL UNPROVEN: the two branches that need real fixtures — refusing a workspace
-- with other people in it, and refusing one that holds business data. Proving
-- those needs a seeded tenant, so they belong in supabase/tests/ (not in CI and
-- not in the Stop hook — see CLAUDE.md §25.2 — so run them by hand).
-- ============================================================================
-- ⚠️ DO NOT use information_schema.routine_privileges here. It was tried first and
-- reported "0 EXECUTE grants to authenticated" for functions that were in fact
-- granted correctly — that view filters rows to roles the CURRENT role belongs to,
-- and the migration runner is not a member of `authenticated`. Read pg_proc.proacl,
-- which is the grant itself.
--
-- Expect BOTH functions to show exactly:
--     postgres=X/postgres | authenticated=X/postgres | service_role=X/postgres
-- No bare `=X/postgres` (that is PUBLIC) and no `anon=X`. For contrast, the older
-- create_tenant_backup carries both — these two are deliberately tighter.
/*
select p.proname,
       coalesce(array_to_string(p.proacl, ' | '), '(default: PUBLIC EXECUTE)') as acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('merge_stranded_user_into_tenant',
                     'list_stranded_auth_users',
                     'create_tenant_backup');
*/
