-- ============================================================================
-- Only an owner may change role, manager, deals access, workspace or active status.
--
-- ⚠️ NOT APPLIED. Found 18 Aug 2026 while wiring the "Reports to" picker. The permission
--    classifier blocked me from running DDL, and this one should be read before it is run
--    anyway — see THE CARVE-OUT below.
--
-- WHAT IS WRONG TODAY
--   Read out of pg_policies on the live database:
--       users_tenant_update  UPDATE  using (tenant_id = current_tenant_id())   with_check NULL
--       users_self_update    UPDATE  using (id = auth.uid())                   with_check NULL
--   Neither restricts WHICH COLUMNS may change, and when WITH CHECK is null Postgres reuses
--   the USING expression for the check. So any authenticated member of a tenant may update
--   any teammate's row, including `role`.
--
--   Concretely, on this workspace: pratik@anutech.in (support) can send one PostgREST PATCH
--   and become an owner. Nothing in the app offers that — the Team page hides the role
--   dropdown behind `isOwner` — but the API is the boundary, not the page, and a UI check is
--   a suggestion to anybody holding their own access token.
--
-- WHY IT SURFACED NOW
--   Step 1 of the hierarchy brief says "allow ADMINS to assign each team member their
--   reporting manager". The picker I just added is gated on isOwner in React, which makes
--   that sentence true on screen and false in the database — the same shape of gap as the
--   RLS policies in the hierarchy migration, found the same way: by reading what already
--   exists instead of trusting what the UI does. manager_id is the column that decides who
--   sees whose pipeline, so leaving it writable by everyone would undo the feature it
--   belongs to.
--
-- WHY A TRIGGER AND NOT A POLICY
--   RLS cannot express "this column may not change". It decides which ROWS you may touch,
--   not which fields. Splitting into column privileges (`grant update (col) on users`) is
--   the other option, but grants are per-role, and this rule is per-ROW-DATA — it depends
--   on the caller's own role stored in the same table.
--
-- ⚠️ THE CARVE-OUT, AND THE RISK IN IT
--   Triggers fire for service_role too, unlike RLS. Trusted server paths run with the admin
--   client and therefore have no auth.uid(): the OAuth callback, the claim/merge API,
--   reset-data. Blocking those would break sign-in for new teammates — a much worse outage
--   than the hole being closed. So `auth.uid() is null` is allowed through.
--
--   That is a real widening and it should be said plainly: anything holding the service_role
--   key can still change any of these columns. That key is server-only (CLAUDE.md §4) and is
--   already trusted with far more than this. The alternative — enumerating every legitimate
--   server path — is a list that goes stale silently, and a stale allow-list fails open.
--
-- WHAT THIS BREAKS — CHECKED, NOT ASSUMED
--   Every write to `users` in the codebase, 18 Aug 2026:
--       src/app/(app)/team/page.tsx:103   .from("users").update(patch)   ← the only one on the
--                                          browser client, already owner-gated in the UI
--       src/app/(auth)/callback/route.ts:127  admin.update({id, full_name, initials})
--       callback / signup / onboarding routes  admin.insert(...)  — INSERT, trigger is
--                                          BEFORE UPDATE only, so unaffected
--   The one browser-side update is the control this trigger is meant to back up, and every
--   other write is either an insert or goes through the admin client and takes the carve-out.
--   So enabling this changes nothing that works today; it only closes the direct-API path.
-- ============================================================================

begin;

create or replace function public.guard_privileged_user_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_owner boolean;
begin
  /* Nothing privileged changed — a name, initials, colour, avatar. Leave it alone, so the
     common case pays no cost and self-service editing keeps working. */
  if new.role           is not distinct from old.role
     and new.manager_id     is not distinct from old.manager_id
     and new.can_view_deals is not distinct from old.can_view_deals
     and new.tenant_id      is not distinct from old.tenant_id
     and new.is_active      is not distinct from old.is_active then
    return new;
  end if;

  /* Trusted server code — see THE CARVE-OUT in the header. */
  if auth.uid() is null then
    return new;
  end if;

  select exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'owner'
  ) into v_is_owner;

  if not v_is_owner then
    /* Phrased as a next step, not a bare refusal — CLAUDE.md §24. The person who hits this
       is either an admin who lost their owner role or somebody probing the API; both are
       better served by being told where the control lives. */
    raise exception 'Only an owner can change a teammate''s role, reporting manager, deals access, workspace or active status. Ask an owner to do it on the Team page (/team).';
  end if;

  return new;
end;
$$;

comment on function public.guard_privileged_user_columns() is
  'Blocks non-owners from changing users.role / manager_id / can_view_deals / tenant_id / is_active. RLS cannot restrict columns, only rows. Callers with no auth.uid() (service_role) pass through — see the migration header.';

drop trigger if exists users_privileged_columns_guard on public.users;
create trigger users_privileged_columns_guard
  before update on public.users
  for each row
  execute function public.guard_privileged_user_columns();

commit;

-- ─── HOW TO VERIFY (a SEPARATE run from the DDL — AGENTS.md §5) ───────────────
--   ✅ VERIFIED 19 Aug 2026 — automated, no human step. Run:
--       cd production && env -u SUPABASE_ACCESS_TOKEN \
--         npx supabase db query --linked -f supabase/tests/users_privileged_columns_owner_only.test.sql
--   Output on a healthy database is one row: `PASS — guard blocks non-owner …`. Every
--   assertion inside raises instead, so a regression is an ERROR, never a quiet pass.
--
--   ⚠️ THE PARAGRAPH THAT USED TO BE HERE WAS WRONG, and being wrong is what kept this
--   trigger unproven for a day. It said the real test "needs two sessions and cannot be
--   done from a superuser connection", and so handed the check to a person, who did not
--   do it. But a superuser connection takes the carve-out only because it has no
--   auth.uid() — and auth.uid() is nothing but `request.jwt.claims ->> 'sub'`, which
--   `set_config(..., true)` sets for the transaction. `set local role authenticated`
--   puts RLS back in force on top. One connection proves both sides, rolled back.
--   portal_customer_users_no_self_update.test.sql was already doing exactly this.
--
--   What the run actually proved, on the live database: a support user is blocked from
--   escalating their own role AND from re-pointing a teammate's manager_id (both with
--   this function's own message, not a generic RLS refusal — a "0 rows changed" pass
--   would survive the trigger being dropped); an ordinary self-edit of full_name still
--   succeeds; an owner can still change a teammate's role; and a caller with no
--   auth.uid() still passes through, so the OAuth-callback path is not bricked.
--
-- ─── ROLLBACK ─────────────────────────────────────────────────────────────────
--   drop trigger if exists users_privileged_columns_guard on public.users;
--   drop function if exists public.guard_privileged_user_columns();
