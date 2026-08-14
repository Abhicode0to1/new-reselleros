-- ============================================================================
-- 0242 — Domain ownership + join requests (the "accidental tenant" fix)
-- ============================================================================
--
-- ─── THE FAILURE THIS EXISTS TO PREVENT ─────────────────────────────────────
-- On 11 Aug 2026 a colleague signed in with `ranjeetraj@exceltechnologies.in`.
-- The pending invite was addressed to `ranjeet@anutech.in`, so the exact-string
-- match in `(auth)/callback/route.ts` found nothing, and the callback did what it
-- was written to do: created him a brand-new tenant. It was auto-named from his
-- email domain — so the private, wrong workspace was called "Excel Technologies",
-- exactly what he expected to see. He worked in it for two days: 3 real customers,
-- an active Google Workspace subscription, and a ₹21,240 payment, all landing in a
-- tenant nobody else could see.
--
-- The root cause is not the matching rule. It is that the system COMMITS to an
-- answer ("you are a new company") at the one moment it cannot possibly know, and
-- the wrong answer is indistinguishable from the right one on screen.
--
-- ─── WHAT THESE TWO TABLES CHANGE ───────────────────────────────────────────
-- `tenant_domains` gives the system the one strong signal it always had and never
-- used: the email domain. `join_requests` gives it somewhere to PARK a person
-- while a human decides, instead of manufacturing a company for them.
--
-- ─── WHY A DOMAIN MATCH MUST NEVER AUTO-JOIN ────────────────────────────────
-- CLAUDE.md §4 is explicit: no invite → never join someone else's tenant. A domain
-- match is evidence, not authorisation. If matching alone let you in, anyone who
-- could obtain an address at a lookalike domain would walk into that tenant's
-- customer list. So a match produces a row here with status 'pending_approval'
-- and NOTHING else — no users row, no tenant, no access. An owner clicks Approve.
-- That keeps the tenant-leak guard intact while removing the silent wrong branch.
--
-- ─── WHY `verified_at` IS NOT DECORATION ────────────────────────────────────
-- Only a VERIFIED domain routes anyone anywhere. Seeding every tenant's domain as
-- verified would be unsafe here for a concrete reason, measured in this database
-- when this migration was applied: `anutech.in` is the primary email domain of
-- THREE tenants — the real company, plus two created by accident whose
-- `tenants.email` also happens to be an @anutech.in address. Auto-verifying would
-- hand the domain to whichever row sorted first and start routing real people into
-- a mistake. The `order by created_at` below is what makes the real company (26 May
-- 2026) win over the two accidents (8 and 12 Aug), and the seed verifies only the
-- distributor's claim — the one tenant whose ownership is not in question.
--
-- Note for the next reader: a tenant's `email` column is NOT the same thing as the
-- domain its people sign in with. `Exceltechnologies` carries `pratik@anutech.in`
-- even though the person who created it signed in as `hitesh@exceltechnologies.in`.
-- That is exactly why domain ownership needs its own table instead of being derived
-- on the fly from whatever address happens to be on the tenant row.
--
-- ─── HOW TO RUN (CLAUDE.md §25.6) ───────────────────────────────────────────
-- One batch at a time. The verify block at the bottom is a SEPARATE run — putting
-- it in the same run makes it report success for DDL that is about to roll back.
-- ============================================================================

-- ───────────────────────────────────────────────────────────────────────────
-- BATCH 1 · Tables
-- ───────────────────────────────────────────────────────────────────────────
begin;

create table if not exists public.tenant_domains (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  -- Bare domain, lower-case, no "@" and no leading dot: `anutech.in`.
  domain      text not null check (
                domain = lower(domain)
                and domain not like '%@%'
                and domain like '%.%'
                and length(btrim(domain)) > 3
              ),

  /* NULL = claimed but not proven. Only a non-null value routes a signup.
     Set it when the owner has demonstrated control of the domain — today that
     means a human confirming it; a DNS TXT check can replace that later without
     touching any caller, because every caller only reads this column. */
  verified_at timestamptz,

  created_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

comment on table public.tenant_domains is
  'Email domains belonging to a tenant. A signup whose domain matches a VERIFIED row here is parked in join_requests for owner approval — never auto-joined (CLAUDE.md §4).';
comment on column public.tenant_domains.verified_at is
  'NULL means claimed but unproven, and unproven domains route nobody. Deliberate: exceltechnologies.in is currently claimed by two accidentally-created tenants.';

-- Global, not per-tenant. Two tenants claiming one domain is precisely the
-- ambiguity that would send a person to the wrong company, so the database
-- refuses it rather than leaving the app to pick.
create unique index if not exists tenant_domains_domain_unique
  on public.tenant_domains (lower(domain));
create index if not exists tenant_domains_tenant_idx
  on public.tenant_domains (tenant_id);


create table if not exists public.join_requests (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  /* The Supabase Auth uid, when the person has already authenticated. Plain uuid,
     NOT a foreign key into auth.users: if that account is ever removed we still
     want the record of who asked and what was decided. */
  auth_user_id  uuid,

  email         text not null check (email = lower(email) and email like '%@%'),
  full_name     text,

  -- What they would get on approval. The owner can change it at the moment of
  -- approving; this is the proposal, not the grant.
  requested_role public.user_role not null default 'support',

  status        text not null default 'pending_approval'
                check (status in ('pending_approval', 'approved', 'rejected')),

  -- How this request came to exist. 'domain' is the automatic path; 'manual' is
  -- someone typing their company in on the onboarding screen.
  matched_by    text not null check (matched_by in ('domain', 'manual')),

  note          text,

  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by    uuid references public.users(id) on delete set null
);

comment on table public.join_requests is
  'A person waiting for an owner to let them into a tenant. Holds NO access of its own — approving it is what creates the public.users row.';

-- One open request per person per tenant. A partial unique index rather than a
-- plain one, so a rejected request does not block them from asking again later.
create unique index if not exists join_requests_one_open_per_email
  on public.join_requests (tenant_id, lower(email))
  where status = 'pending_approval';

create index if not exists join_requests_tenant_status_idx
  on public.join_requests (tenant_id, status, created_at desc);

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- BATCH 2 · RLS
--
-- Both tables are read through `public.current_tenant_id()`, the same helper the
-- other 335 policies use — NOT a JWT claim, which does not carry tenant_id in this
-- project (see 0234's header for what that mistake looks like).
--
-- Writes to join_requests are deliberately NOT granted to `authenticated`. Rows
-- are created by the signup/callback paths, which run with the service-role key
-- and bypass RLS; a signed-in user has no business inserting one for themselves.
-- Only the decision (approve/reject) is an in-app write, and only for owner and
-- manager.
-- ───────────────────────────────────────────────────────────────────────────
begin;

alter table public.tenant_domains enable row level security;
alter table public.join_requests  enable row level security;

create policy "tenant_domains_select" on public.tenant_domains
  for select to authenticated using (tenant_id = public.current_tenant_id());

create policy "tenant_domains_write" on public.tenant_domains
  for all to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.users u
                 where u.id = auth.uid() and u.role = 'owner')
  )
  with check (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.users u
                 where u.id = auth.uid() and u.role = 'owner')
  );

create policy "join_requests_select" on public.join_requests
  for select to authenticated using (tenant_id = public.current_tenant_id());

create policy "join_requests_decide" on public.join_requests
  for update to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and exists (select 1 from public.users u
                 where u.id = auth.uid() and u.role in ('owner', 'manager'))
  )
  with check (tenant_id = public.current_tenant_id());

-- No insert or delete policy for `authenticated`, on purpose. Belt and braces:
revoke insert, delete on public.join_requests from authenticated;
revoke insert, delete on public.join_requests from anon;

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- BATCH 3 · Seed
--
-- Claim each tenant's own primary email domain, skipping consumer mail providers
-- (a tenant registered from a gmail.com address does not own gmail.com — claiming
-- it would route every future Gmail signup on the platform into that one tenant).
--
-- Verified only for the distributor. See the header for why the rest stay unproven.
-- ───────────────────────────────────────────────────────────────────────────
begin;

insert into public.tenant_domains (tenant_id, domain, verified_at)
select
  t.id,
  lower(split_part(t.email, '@', 2)) as domain,
  case when t.tier = 'distributor' then now() else null end
from public.tenants t
where t.email is not null
  and t.email like '%@%.%'
  and lower(split_part(t.email, '@', 2)) not in (
    'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.in', 'yahoo.co.in',
    'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
    'rediffmail.com', 'icloud.com', 'me.com', 'aol.com',
    'proton.me', 'protonmail.com', 'zoho.com', 'zohomail.com', 'mail.com'
  )
order by t.created_at            -- deterministic winner when a domain is contested
on conflict do nothing;

commit;


-- ============================================================================
-- VERIFY — RUN THIS AS A SEPARATE EDITOR RUN
--
-- Expect: tables 2 · rls enabled 2 · policies 4
--         verified domains = 1        ← anutech.in, the distributor's, and only it
--         join_requests acl shows authenticated WITHOUT `a` (insert) and `d` (delete)
--
-- ⚠️ DO NOT use information_schema.table_privileges for the grant check. It was
-- tried first and it is worse than useless here: it filters rows to roles the
-- CURRENT role belongs to, so it returned "0 INSERT privileges for authenticated"
-- — the expected answer — for a table where the revoke had NOT been tested at all.
-- A verification that returns the right answer for the wrong reason is how a
-- broken guard ships. `pg_class.relacl` is the real grant, so read that: compare
-- join_requests against team_invites, which never had anything revoked.
-- ============================================================================
/*
select 'tables' as thing, count(*)::text as n from information_schema.tables
 where table_schema='public' and table_name in ('tenant_domains','join_requests')
union all
select 'rls enabled', count(*)::text from pg_tables
 where schemaname='public' and tablename in ('tenant_domains','join_requests') and rowsecurity
union all
select 'policies', count(*)::text from pg_policies
 where schemaname='public' and tablename in ('tenant_domains','join_requests')
union all
select 'verified domains (expect 1)', count(*)::text from public.tenant_domains
 where verified_at is not null
union all
select 'claimed: ' || d.domain, coalesce(t.name,'?')
  from public.tenant_domains d join public.tenants t on t.id = d.tenant_id;

-- The grant check, read from the catalog. join_requests must show
-- `authenticated=rwDxtm` (no `a`, no `d`); team_invites shows `arwdDxtm`.
select c.relname, coalesce(array_to_string(c.relacl, ' | '), '(default)') as acl
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('join_requests', 'tenant_domains', 'team_invites');
*/
