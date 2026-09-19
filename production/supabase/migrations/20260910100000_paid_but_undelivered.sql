-- ═══════════════════════════════════════════════════════════════════════════
-- Paid, but not delivered — a bounded retry budget and a resolution trail.
--
-- Ported from the DMS engine's `PendingDomain` model (182 lines) on 10 Sep 2026,
-- at Pawan's request for all five of the zero-row DMS features.
--
-- ─── WHAT PendingDomain ACTUALLY IS ───────────────────────────────────────────
-- Its own default reason gives it away: "Domain registration failed - likely due
-- to insufficient funds". It is NOT a pre-payment hold, which is what this
-- repo's own notes had guessed. It is the record of a domain the CUSTOMER HAS
-- PAID FOR AND DOES NOT HAVE — usually because the ResellerClub wallet was empty
-- when the order was placed. That is the worst state in the whole domain path,
-- and DMS was right to give it a home.
--
-- ─── WHY THIS IS NOT A NEW TABLE ─────────────────────────────────────────────
-- DMS kept `PendingDomain` beside `Domain`. Here, `domains` already holds
-- `status='failed'`, `last_error`, `last_error_at`, `amount_paid`, `quote_id` and
-- `subscription_id` — so a second table would duplicate the identity of a domain
-- and invite the two to disagree about which one is real. The liability question
-- ("who paid for a name they do not have, and how much") is already answerable:
--
--     select domain_name, amount_paid from domains
--      where status = 'failed' and amount_paid > 0 and resolved_at is null;
--
-- What was genuinely missing is on this migration: how many times we have tried,
-- and whether a person has dealt with it.
--
-- ─── THE RETRY BUDGET IS THE POINT ───────────────────────────────────────────
-- `api/cron/provision-domain` marks a row `failed` and leaves it, with a comment
-- saying failed rows "get retried by hand". Nobody retries by hand at 2am, and
-- an empty wallet is exactly the failure that fixes itself the moment somebody
-- tops up. So the sweep can now re-attempt on a backoff — but a BOUNDED number
-- of times, because a registration that keeps failing for a real reason (a name
-- somebody else took in the meantime) must stop and ask for a human rather than
-- hammer the registrar forever.
--
-- ─── AND WHY A RESOLUTION IS RECORDED, NOT A DELETION ────────────────────────
-- DMS soft-deleted these with `isArchived/archivedAt/archivedBy`. The same
-- instinct, better named: money changed hands, so "we sorted it out" needs to say
-- WHO decided and WHAT they decided. A refunded ₹1,200 and a re-registered domain
-- are both resolutions and they are not the same event.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.domains
  /* 0 means never attempted upstream. Incremented by the worker on every real
     attempt, including the first, so "attempts" reads the way a person counts. */
  add column if not exists attempt_count integer not null default 0
    check (attempt_count >= 0),
  add column if not exists last_attempt_at timestamptz,

  /* Set when a person has dealt with the failure. NULL means it is still open,
     which is what the operator queue filters on. */
  add column if not exists resolved_at timestamptz,
  /* Staff, not customer — `users` holds staff; a portal customer has no row
     there. RESTRICT rather than CASCADE: who signed off on a refund must not
     vanish because somebody was deactivated. */
  add column if not exists resolved_by uuid references public.users(id) on delete restrict,
  /* 'refunded' | 're_registered' | 'alternative_offered' | 'written_off' — text
     rather than an enum because the list of ways to make a customer whole is a
     business decision, and a migration per addition ends with people picking the
     nearest wrong one. */
  add column if not exists resolution text,
  add column if not exists resolution_note text;

/* Both halves or neither. A resolution with nobody's name on it is the thing
   this column exists to prevent, and a name with no date cannot be ordered. */
alter table public.domains
  drop constraint if exists domains_resolution_complete;
alter table public.domains
  add constraint domains_resolution_complete check (
    (resolved_at is null and resolved_by is null and resolution is null)
    or (resolved_at is not null and resolved_by is not null and resolution is not null)
  );

/* The operator queue: paid for, not delivered, nobody has dealt with it yet.
   Ordered by money because that is the order in which these should be looked at.

   NOTE the index does not include `amount_paid > 0` in its predicate — a failed
   registration with no recorded payment is still worth showing, since a missing
   amount is itself a gap somebody should look at rather than a reason to hide
   the row. */
create index if not exists domains_unresolved_failures
  on public.domains (tenant_id, amount_paid desc nulls last)
  where status = 'failed' and resolved_at is null and deleted_at is null;

/* The sweep's own lookup: failures still inside their retry budget. */
create index if not exists domains_retryable
  on public.domains (last_attempt_at nulls first)
  where status = 'failed' and resolved_at is null and deleted_at is null;

comment on column public.domains.attempt_count is
  'Upstream registration attempts made, including the first. The retry budget in lib/domains/retry.ts is measured against this.';
comment on column public.domains.resolved_at is
  'When a person dealt with a paid-but-undelivered registration. NULL = still open; this is what the operator queue filters on.';
