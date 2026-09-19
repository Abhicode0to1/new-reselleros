-- Nobody was told a domain was about to lapse. This is what remembers who was.
--
-- ─── THE GAP, MEASURED 11 SEP 2026 ──────────────────────────────────────────
-- `asset-sweep` keeps `domains.expires_at` accurate and then tells nobody. There
-- was no email, no alert and no notification anywhere in the codebase for an
-- expiring domain — grep for it. In this database that meant:
--
--   acme-legacy.net   grace    2026-09-01   lapsed nine days ago, nobody told
--   acmecorp.com      active   2026-09-21   eleven days left, nobody told
--
-- A domain lapsing quietly is the worst outcome a domain business has: the site
-- and the email stop, the customer hears about it from their own customers, and
-- recovering the name after it drops is somebody else's auction.
--
-- ─── WHY A TABLE AND NOT A COLUMN ───────────────────────────────────────────
-- The cadence is 30 / 14 / 7 / 1 days out plus one after it lapses, and each has
-- to be sendable exactly once. A `last_notice_at` column could not tell "the
-- 14-day went out" from "the 7-day went out", so a cron would either re-send or
-- skip. One row per notice sent is the only shape that answers "has THIS step
-- gone?" without inference.
--
-- ─── THE UNIQUE KEY CARRIES THE TERM, AND THAT IS THE WHOLE DESIGN ──────────
--        unique (domain_id, step, term_expires_at)
--
-- Not `(domain_id, step)`. When a domain renews, its `expires_at` moves a year
-- and every step must become available again — otherwise a customer is warned
-- once in the domain's lifetime and then never again, through every later
-- renewal, and the second lapse is silent exactly like the first.
--
-- Putting the expiry in the key means a renewal resets the cadence with nothing
-- to delete and no cleanup job. It also makes the history readable: the rows for
-- last year's term stay, so "did we warn them in 2026?" is answerable.
--
-- ─── DOMAINS ARE NOT SUBSCRIPTIONS HERE ─────────────────────────────────────
-- `renewal_email_log` already does this job for subscriptions, with a
-- `cadence_step` column, and reusing it was the obvious move. It is keyed on
-- `subscription_id`, and Pardeep chose (11 Sep 2026) that domains get their own
-- renewal path rather than becoming subscription rows — because a ₹900/year
-- domain turning into ₹75/month of recurring revenue would change MRR and the
-- subscriptions list, figures already being quoted. So this is a parallel table
-- on purpose, and `lib/domains/renewal-notice.ts` is a parallel cadence.

create table if not exists public.domain_renewal_notices (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  domain_id  uuid not null references public.domains(id) on delete cascade,

  /* Which warning. Mirrors RenewalNoticeStep in lib/domains/renewal-notice.ts —
     change both together. */
  step       text not null check (step in ('d30', 'd14', 'd7', 'd1', 'lapsed')),

  /* The expiry this notice was about. A DATE and not a timestamp: the cadence is
     counted in calendar days (IST) and a timestamp would make the same term key
     differ by the hour a row was written. */
  term_expires_at date not null,

  /* Who it went to, and what it said. Kept because "we warned them" is a claim
     somebody will need to support, and the address on the customer row may have
     changed since. */
  recipient_email text,
  subject         text,

  /* Non-null means it really went. A row that failed to send is still recorded —
     with `sent_at` null and the reason — so the cron does not retry it forever
     and a person can see it stuck. */
  sent_at    timestamptz,
  error      text,

  created_at timestamptz not null default now()
);

/* One notice per step per TERM. See the header — the term is the point. */
create unique index if not exists uq_domain_renewal_notices_step
  on public.domain_renewal_notices (domain_id, step, term_expires_at);

create index if not exists idx_domain_renewal_notices_tenant
  on public.domain_renewal_notices (tenant_id, created_at desc);

alter table public.domain_renewal_notices enable row level security;

/* Staff read their own tenant's. No customer policy: the customer receives the
   email, and a portal screen listing "when we emailed you" is not a thing
   anybody has asked for. Adding one later is a policy, not a migration. */
drop policy if exists domain_renewal_notices_staff on public.domain_renewal_notices;
create policy domain_renewal_notices_staff on public.domain_renewal_notices
  for select
  using (tenant_id = public.current_tenant_id());

/* The cron writes. Named `zzz_` to match the convention on hosting_accounts. */
drop policy if exists zzz_service_role_all on public.domain_renewal_notices;
create policy zzz_service_role_all on public.domain_renewal_notices
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

comment on table public.domain_renewal_notices is
  'One row per expiry warning sent about a domain. The unique key carries term_expires_at, so a renewal makes the whole 30/14/7/1/lapsed cadence available again with nothing to delete — keying on (domain_id, step) alone would warn a customer once in the domain''s life and stay silent through every later renewal. Written by /api/cron/domain-expiry; the cadence rules are in lib/domains/renewal-notice.ts.';

comment on column public.domain_renewal_notices.sent_at is
  'Null with a non-null `error` means the send failed and was recorded rather than retried forever. The row still occupies the unique key, which is deliberate: a mail server refusing us is not a reason to email a customer five times.';
