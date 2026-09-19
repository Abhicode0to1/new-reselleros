-- A domain renewal: the money, and then the thing we file at the registrar.
--
-- Pardeep, 11 Sep 2026: "Proceed with those" — the two halves of domain renewal
-- left after the expiry warnings.
--
-- ─── WHY NOT `provisioning_requests` ────────────────────────────────────────
-- That table already carries "a customer paid, go and do the upstream thing",
-- with a status machine and a `payment_mode` gate, and reusing it was the first
-- idea. It is the wrong home for two reasons, one of them dangerous:
--
--   · `listReadyDomainRequests` filters `vendor = 'domain'`, and
--     `/api/cron/provision-domain` acts on what it returns by REGISTERING the
--     name. A renewal row with that vendor would make the provisioning cron try
--     to register a domain that already exists — at best an error, at worst a
--     second order for a name the customer already owns.
--   · `vendor` has a CHECK constraint listing upstreams (google, microsoft,
--     zoho, hosting, domain, other). A renewal is not a different upstream, it
--     is a different ACTION on the same one, so widening that list would make
--     the column mean two things.
--
-- And the wider decision behind it: Pardeep chose (11 Sep) that a domain does
-- NOT become a subscription row, because a ₹900/year domain turning into ₹75 of
-- MRR would change figures already being quoted. Domain renewal is a parallel
-- path all the way down, and this is its table.
--
-- ─── ONE ROW IS ONE ATTEMPT TO RENEW ONE TERM ───────────────────────────────
-- Created when the quote is raised, and it is the only link from "this money
-- arrived" to "file this renewal at ResellerClub". Without it a paid renewal
-- quote is indistinguishable from any other paid quote and nothing would ever
-- file anything — which is exactly the state the codebase was in: `rcRenewDomain`
-- has existed since the 9 Sep port with no caller anywhere.
--
-- ─── `from_expires_at` IS THE DUPLICATE GUARD, AND IT IS NOT COSMETIC ───────
-- ResellerClub's renew API takes `exp-date` and uses it to detect a repeat
-- renewal — send the wrong one and a domain gets renewed twice, at double cost,
-- with the second year credited to nobody. `rcRenewDomain` therefore REQUIRES it
-- as an argument rather than looking it up, so the caller has to have read the
-- domain's real details first.
--
-- This column records the expiry the renewal was QUOTED against. The cron still
-- re-reads the live value from RC immediately before filing (that is the value
-- it sends), and compares: if the domain has moved on since the quote — somebody
-- renewed it by hand, or a previous attempt actually succeeded and we did not
-- record it — it refuses instead of filing again. The unique index below is the
-- second half of that guard.

create table if not exists public.domain_renewals (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  domain_id   uuid not null references public.domains(id) on delete cascade,
  /* Denormalised, like `hosting_plan_changes.domain_name`: six months on, the
     domain row may be closed or transferred out, and a renewal record that
     cannot say which name it was about is not a record. */
  domain_name text not null,
  customer_id uuid references public.customers(id) on delete restrict,

  /* Whole years, the same 1-10 bound rcRenewDomain enforces. */
  years       integer not null default 1 check (years >= 1 and years <= 10),

  /* The expiry this renewal extends FROM — see the header. */
  from_expires_at date not null,

  /* The money. NOT NULL: a renewal row with no quote is an intention, and this
     table is only for renewals somebody has been asked to pay for. */
  quote_id    text not null,

  status      text not null default 'quoted'
              check (status in ('quoted', 'renewed', 'failed', 'cancelled')),

  /* ─── What came back from the registrar ────────────────────────────────────
     `registrar_order_id` is copied from the domain at quote time so the record
     is self-contained, but the cron re-reads it live before filing. */
  registrar_order_id text,
  renewed_at    timestamptz,
  /* The expiry RC reports AFTER the renewal. Written from RC's own answer and
     not computed as from_expires_at + years: registrars apply their own rules
     about grace-period renewals, and a computed date that disagrees with the
     registrar is a date that will confuse somebody a year from now. */
  new_expires_at date,

  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_action_at timestamptz,
  last_error    text,
  last_error_at timestamptz,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

/* ─── ONE OPEN RENEWAL PER TERM ───────────────────────────────────────────────
   Two `quoted` rows for the same domain and the same starting expiry would be
   two quotes for one renewal, and if both were paid, two renewals filed. The
   index makes the second insert fail rather than relying on a read-then-write
   that two clicks in the same second both pass.

   Partial on `quoted` so the history is unlimited: next year's renewal has a
   different `from_expires_at` anyway, and a failed attempt must not block a
   retry. */
create unique index if not exists uq_domain_renewals_one_open
  on public.domain_renewals (domain_id, from_expires_at)
  where status = 'quoted';

create index if not exists idx_domain_renewals_tenant
  on public.domain_renewals (tenant_id, created_at desc);

/* The cron's queue: quoted rows, oldest first. */
create index if not exists idx_domain_renewals_open
  on public.domain_renewals (status, created_at)
  where status = 'quoted';

alter table public.domain_renewals enable row level security;

/* Staff: their tenant's, read and write. Resolving the tenant through `users` is
   what makes this staff-only — a portal customer has no row there. */
drop policy if exists domain_renewals_staff on public.domain_renewals;
create policy domain_renewals_staff on public.domain_renewals
  for all
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

/* The customer may SEE their own renewal — the portal shows "renewal quoted,
   waiting on you" beside the domain. Read only; there is no command here a
   customer should run, and least of all `status = 'renewed'`. */
drop policy if exists domain_renewals_select_own_customer on public.domain_renewals;
create policy domain_renewals_select_own_customer on public.domain_renewals
  for select
  using (customer_id = public.current_customer_id());

drop policy if exists zzz_service_role_all on public.domain_renewals;
create policy zzz_service_role_all on public.domain_renewals
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop trigger if exists trg_domain_renewals_updated_at on public.domain_renewals;
create trigger trg_domain_renewals_updated_at
  before update on public.domain_renewals
  for each row execute function public.handle_updated_at();

comment on table public.domain_renewals is
  'One attempt to renew one domain term. The only link between a paid renewal quote and rcRenewDomain — without it a paid renewal is indistinguishable from any other paid quote and nothing files anything, which is the state the app was in until 11 Sep 2026. Deliberately NOT provisioning_requests: that table''s vendor=''domain'' rows are picked up by provision-domain, which would try to REGISTER a name the customer already owns.';

comment on column public.domain_renewals.from_expires_at is
  'The expiry this renewal was quoted against. ResellerClub uses exp-date to detect a repeat renewal, so the cron re-reads the LIVE value before filing and refuses if it has moved — somebody renewing by hand, or an earlier attempt that succeeded without being recorded, both show up as a changed expiry.';

comment on column public.domain_renewals.new_expires_at is
  'Taken from ResellerClub''s answer after the renewal, never computed as from_expires_at + years. Registrars apply their own rules to grace-period renewals, and a computed date that disagrees with the registrar is the date somebody trusts a year later.';
