-- R-048 (4 Oct 2026): a signup must prove it owns its email before the account can sign in.
--
-- The signup route created every auth user with email_confirm = true, so anyone could open an
-- account — or a join request to someone else's company — with an address they do not own.
-- Now the user is created unconfirmed and gets a one-time link; following it confirms the
-- address (admin API, server side) and only then does GoTrue allow a password sign-in.
--
-- Our own token, not GoTrue's mailer link: live runs GoTrue v2.151, local v2.195, and their
-- link / verify behaviour differs between versions. The admin "confirm" call is the same in
-- both. Only the SHA-256 of the token is stored; the token itself lives only in the email.
-- Server-only table: RLS on, no client policies, service role only.

create table if not exists public.email_verifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  email       text not null,
  token_hash  text not null unique check (char_length(token_hash) = 64),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists email_verifications_user_idx on public.email_verifications (user_id);

alter table public.email_verifications enable row level security;
revoke all on public.email_verifications from anon, authenticated;
grant all on public.email_verifications to service_role;

-- Cloud SQL has no BYPASSRLS: the service role needs an explicit policy (see 01b).
drop policy if exists zzz_service_role_all on public.email_verifications;
create policy zzz_service_role_all on public.email_verifications
  as permissive for all to service_role using (true) with check (true);
