-- 0073_team_invites.sql
-- Real teammate invites — an owner pre-authorizes an email to JOIN their tenant.
-- When that email first signs in with Google, the OAuth callback finds the invite
-- and creates their users row inside the inviting tenant (instead of spinning up a
-- brand-new empty tenant).
--
-- SECURITY (multi-tenant, CLAUDE.md §4 — tenant leak is risk #1):
--   - RLS: only an OWNER of a tenant can see/create/delete invites for THAT tenant.
--   - UNIQUE(lower(email)) globally: an email can be invited to at most one tenant,
--     so there is never ambiguity about which tenant a new sign-in joins (prevents
--     a second tenant "claiming" someone else's email).
--   - The callback matches the invite by exact (lower) email only.
create table if not exists public.team_invites (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  email       text not null,
  role        public.user_role not null default 'sales',
  invited_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  accepted_at timestamptz
);

create unique index if not exists team_invites_email_unique
  on public.team_invites (lower(email));

alter table public.team_invites enable row level security;

drop policy if exists "team_invites_owner_manage" on public.team_invites;
create policy "team_invites_owner_manage"
  on public.team_invites for all
  to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner')
  )
  with check (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner')
  );
