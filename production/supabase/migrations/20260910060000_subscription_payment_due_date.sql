-- ============================================================================
-- Postpaid subscriptions get a payment due date — 10 Sep 2026.
--
-- WHY
--   Selecting "Postpaid / Credit Terms" activates a subscription and books the
--   full GST-inclusive balance as owed, and until now NOTHING said when that
--   money was expected. The app's whole reminder ladder (pre-due nudge, day
--   1/3/7/14, grace warning, final notice, optional suspend) hangs off an
--   INVOICE's due_date — and this path raises no invoice, by the owner's
--   decision: issuing a tax invoice creates a GST liability on money that, in
--   this business, sometimes never arrives.
--
--   So the due date lives on the subscription instead. It is typed in by the
--   operator at onboarding (Abhishek, 10 Sep 2026 — not derived from the
--   customer's payment terms, and counted from the SUBSCRIPTION START DATE),
--   defaulting to start + 30 days in the form.
--
-- WHAT READS IT
--   A countdown on the subscription row and on /payments — "26 days left",
--   "Due today", "5 days overdue" with the row highlighted — so an unpaid
--   credit sale cannot go quiet. Step 2 (extending the dunning cron to chase
--   these without an invoice) will read the same column.
--
-- NULL IS MEANINGFUL, and is the default
--   Null = "no agreed date on this record", which is every subscription that
--   existed before today and every prepaid one. Those show no countdown rather
--   than a guessed one: back-filling start + 30 onto historical rows would
--   invent an agreement nobody made and light several of them up as overdue.
--   Deliberately left to a separate, explicit decision.
-- ============================================================================

alter table public.subscriptions
  add column if not exists payment_due_date date;

comment on column public.subscriptions.payment_due_date is
  'Postpaid only: the date the operator agreed the balance is due, typed in at '
  'onboarding and counted from start_date. NULL = no agreed date (prepaid, or '
  'created before 10 Sep 2026) and no countdown is shown. Drives the countdown '
  'chip on /subscriptions and /payments. NOT an invoice due_date — this path '
  'deliberately raises no invoice.';

-- Partial index: every reader wants "the postpaid ones with a date", never the
-- nulls, and the nulls are the majority.
create index if not exists idx_subscriptions_payment_due_date
  on public.subscriptions (tenant_id, payment_due_date)
  where payment_due_date is not null;
