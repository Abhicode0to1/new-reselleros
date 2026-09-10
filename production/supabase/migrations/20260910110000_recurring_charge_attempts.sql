begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- Every recurring debit the gateway told us about — including the ones that failed.
--
-- Ported from the DMS engine's `RecurringChargeAttempt` (128 lines) on 10 Sep
-- 2026, ADAPTED rather than copied. Fifth of the five zero-row DMS features.
--
-- ─── WHY IT IS ADAPTED, AND WHAT THAT CHANGES ────────────────────────────────
-- DMS's model is a RETRY ENGINE for Razorpay's Tokens flow, where the merchant is
-- responsible for re-charging a failed merchant-initiated transaction: it carries
-- `nextAttemptAt`, a T+1/T+3/T+7 policy and an `abandoned` state, and its own
-- header says "Unlike the Subscriptions-API flow (where Razorpay manages retries
-- for us)".
--
-- This app is on the SUBSCRIPTIONS flow — `payment_mandates` holds
-- `gateway_plan_id` and `gateway_subscription_id`, and `lib/payments/mandate.ts`
-- says plainly that `active` is reachable only from a gateway event. So Razorpay
-- owns the retrying, and porting a retry engine would build a scheduler for a
-- flow this app does not use.
--
-- What IS missing is the other half of that model, and it is the half that
-- matters here: A RECORD OF EACH ATTEMPT. Today `subscription.pending` and
-- `subscription.halted` both move the mandate to `paused` and nothing else is
-- kept — so "paused" cannot distinguish a one-off bank decline from a card that
-- has been failing for a month, and does not say which amount failed or why.
-- Worse, `payment.failed` is ignored outright while the webhook's own header
-- claims "log so Pardeep can follow up".
--
-- ─── THE FAILURE THIS PREVENTS ───────────────────────────────────────────────
-- Autopay stops collecting and the customer keeps the service. Nothing errors on
-- our side — the debit is simply declined — so the first anyone notices is an
-- unpaid renewal everybody assumed was automatic. That is the same trap
-- `mandateHeadroom` was written for, one step later in the same story.
--
-- ─── NO RETRY COLUMNS, DELIBERATELY ──────────────────────────────────────────
-- No `next_attempt_at`, no `abandoned`. Razorpay decides when to retry and tells
-- us via `subscription.pending`; a column of ours saying when the next attempt is
-- due would be a guess about somebody else's scheduler, and a wrong guess on a
-- screen is worse than a blank. `subscription.halted` is Razorpay saying it has
-- given up, which is the real terminal signal and is recorded as an outcome.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.recurring_charge_attempts (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,

  /* All three nullable: a webhook can arrive for a mandate whose subscription has
     since been deleted, and losing the attempt record because its parent went
     away would hide exactly the history somebody is trying to reconstruct. */
  customer_id     uuid references public.customers(id)        on delete set null,
  subscription_id uuid references public.subscriptions(id)    on delete set null,
  mandate_id      uuid references public.payment_mandates(id) on delete set null,

  gateway                 text not null default 'razorpay',
  gateway_subscription_id text,
  gateway_payment_id      text,
  gateway_order_id        text,

  /* ₹ whole rupees (AGENTS.md). NULL when the event carried no amount — a halted
     subscription often does not, and 0 would read as a free debit. */
  amount integer check (amount is null or amount >= 0),

  /* What the gateway said happened.
       succeeded     — money moved (subscription.charged)
       failed        — this attempt was declined (payment.failed)
       pending_retry — Razorpay is retrying on its own schedule (subscription.pending)
       halted        — Razorpay has GIVEN UP. Autopay is dead until re-authorised.
     `halted` is kept apart from `failed` because they need different actions: one
     is a decline to watch, the other is a customer who must approve a new
     mandate before anything will ever collect again. */
  outcome text not null check (outcome in ('succeeded', 'failed', 'pending_retry', 'halted')),

  /* Razorpay's own error fields, kept verbatim. `error_description` is written for
     a person ("Your card has insufficient funds") and is what an operator reads;
     `error_code` is what a pattern across customers shows up in. */
  error_code        text,
  error_description text,

  /* TRUE when the event came from test keys — same reasoning as
     payment_mandates.test_mode: an attempt outlives the key config it was made
     under, so a test decline must never be read as a live one. */
  test_mode boolean not null default true,

  /* When the GATEWAY says it happened, not when we processed it. Webhooks arrive
     late and out of order, and a chart of failures keyed on our receipt time
     would put a Tuesday decline on Wednesday. */
  occurred_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

/* Idempotency. Razorpay redelivers webhooks — that is documented behaviour, not a
   fault — and a redelivered decline must not read as two declines, or a "3 failed
   attempts" count becomes fiction. Partial because a halted event often carries no
   payment id, and those rows are distinguished by the index below instead. */
create unique index if not exists rca_payment_unique
  on public.recurring_charge_attempts (gateway, gateway_payment_id)
  where gateway_payment_id is not null;

/* For the id-less events (halted, pending), the dedup key is the GATEWAY's own
   timestamp, which is byte-identical on a redelivery because it comes out of the
   payload rather than from our clock. Two genuinely separate halts weeks apart
   differ in it and both survive.

   The first version of this index wrapped `occurred_at` in `date_trunc('second',
   …)` to be tolerant of near-misses. Postgres refused it — `date_trunc` on a
   `timestamptz` is STABLE, not IMMUTABLE, because it depends on the session
   TimeZone — and refusing was right: tolerance is not wanted here. A redelivery
   is an exact repeat, and rounding would have merged two real events that
   happened inside the same second. */
create unique index if not exists rca_subscription_event_unique
  on public.recurring_charge_attempts
     (gateway, gateway_subscription_id, outcome, occurred_at)
  where gateway_payment_id is null and gateway_subscription_id is not null;

/* The operator question: who is failing to pay, most recent first. */
create index if not exists rca_failures
  on public.recurring_charge_attempts (tenant_id, occurred_at desc)
  where outcome in ('failed', 'halted');

create index if not exists rca_subscription
  on public.recurring_charge_attempts (subscription_id, occurred_at desc)
  where subscription_id is not null;

create index if not exists rca_customer
  on public.recurring_charge_attempts (customer_id, occurred_at desc)
  where customer_id is not null;

alter table public.recurring_charge_attempts enable row level security;

/* Staff of the owning tenant may READ. Nothing else: every row here is the
   gateway's account of what happened to somebody's money, and an app that can
   edit that account can hide a failed debit. Same reasoning as
   payment_mandates, which has no insert policy either — the service role writes
   these from a signature-verified webhook. */
drop policy if exists rca_select on public.recurring_charge_attempts;
create policy rca_select on public.recurring_charge_attempts
  for select using (tenant_id = (select tenant_id from public.users where id = auth.uid()));

-- No insert, update or delete policy. Deliberate; see above.

comment on table public.recurring_charge_attempts is
  'One row per recurring-debit attempt the gateway reported, successes and failures alike. Razorpay owns the retry schedule (Subscriptions flow) — this is the record, not a scheduler. See lib/payments/charge-attempts.ts.';
comment on column public.recurring_charge_attempts.outcome is
  'succeeded | failed | pending_retry | halted. `halted` means the gateway gave up: autopay collects nothing until the customer authorises a new mandate.';

commit;
