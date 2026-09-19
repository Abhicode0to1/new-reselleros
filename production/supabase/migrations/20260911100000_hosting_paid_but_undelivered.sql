begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- Hosting gets what domains got yesterday: a retry budget and a resolution trail.
--
-- ─── THE ASYMMETRY THIS CLOSES, AND IT IS WORSE THAN THE DOMAIN ONE ──────────
-- `api/cron/provision-domain` writes to `domains` on EVERY branch — the claim
-- before the order, and the reason on each way it can fail. Its header says why:
-- "The asset row is kept (not deleted) carrying the reason, so the desk can see
-- the attempt."
--
-- `api/cron/provision-hosting` writes to `hosting_accounts` EXACTLY ONCE, inside
-- the success path. So when a customer pays and DirectAdmin refuses, what is left
-- behind is:
--
--   · a `provisioning_requests` row marked failed,
--   · an email in whoever's inbox, and
--   · NOTHING in `hosting_accounts`.
--
-- Which means /portal/hosting shows that customer an EMPTY PAGE. They paid, they
-- have no hosting, and the screen that should explain it has nothing to say.
-- There is also nothing for an operator queue to be built from, which is why
-- yesterday's paid-but-undelivered work covered domains only.
--
-- ─── WHY THE COLUMNS ARE THE SAME NAMES AS ON `domains` ─────────────────────
-- Deliberately identical, so `lib/domains/retry.ts` governs both without a
-- second policy. Two retry budgets that drift apart is the failure this repo
-- keeps finding in ported code, and the shapes here are the same shape:
-- something irreversible was attempted upstream after money changed hands.
--
-- `hosting_accounts` already carries `amount_paid`, `last_error`, `last_error_at`
-- and — better than `domains` — `last_error_kind`
-- ('hard_failure' | 'collision_exhausted' | 'server_unreachable'), which is a
-- classification the domain side does not have. That column stays as it is; it
-- answers "what kind of failure" where these answer "how many times, and did
-- anybody deal with it".
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.hosting_accounts
  /* 0 = never attempted upstream. Incremented on every real attempt including
     the first, so "attempts" reads the way a person counts. */
  add column if not exists attempt_count integer not null default 0
    check (attempt_count >= 0),
  add column if not exists last_attempt_at timestamptz,

  add column if not exists resolved_at timestamptz,
  /* Staff, not customer. RESTRICT rather than CASCADE: who signed off on a
     refund must not vanish because somebody was deactivated. */
  add column if not exists resolved_by uuid references public.users(id) on delete restrict,
  /* Same vocabulary as `domains.resolution`, minus nothing — a hosting account
     can be refunded, provisioned by hand, swapped for a different plan, or
     written off, which maps onto the same four words. */
  add column if not exists resolution text,
  add column if not exists resolution_note text;

/* Both halves or neither, exactly as on `domains`. A resolution with nobody's
   name on it is the thing these columns exist to prevent. */
alter table public.hosting_accounts
  drop constraint if exists hosting_accounts_resolution_complete;
alter table public.hosting_accounts
  add constraint hosting_accounts_resolution_complete check (
    (resolved_at is null and resolved_by is null and resolution is null)
    or (resolved_at is not null and resolved_by is not null and resolution is not null)
  );

/* The operator queue: paid for, not delivered, nobody has dealt with it.
   Ordered by money, because that is the order to look at them in. */
create index if not exists hosting_accounts_unresolved_failures
  on public.hosting_accounts (tenant_id, amount_paid desc nulls last)
  where status = 'failed' and resolved_at is null and deleted_at is null;

/* The cron's own lookup: failures still inside their retry budget. */
create index if not exists hosting_accounts_retryable
  on public.hosting_accounts (last_attempt_at nulls first)
  where status = 'failed' and resolved_at is null and deleted_at is null;

comment on column public.hosting_accounts.attempt_count is
  'Upstream provisioning attempts made, including the first. The retry budget in lib/domains/retry.ts is measured against this — the same policy governs domains and hosting on purpose.';
comment on column public.hosting_accounts.resolved_at is
  'When a person dealt with a paid-but-undelivered account. NULL = still open; this is what the operator queue filters on.';

commit;
