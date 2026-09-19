-- ============================================================================
-- The dunning log can record a chase against a SUBSCRIPTION — 10 Sep 2026.
--
-- WHY
--   `invoice_dunning_log` is how the reminder ladder remembers "already sent" —
--   decideDunning reads the most urgent step logged and refuses to repeat it.
--   Without a row, a daily cron would re-send the day-7 grace warning every
--   single day until somebody paid.
--
--   Postpaid subscriptions now carry their own due date
--   (`subscriptions.payment_due_date`, migration 20260910060000) and must enter
--   that same ladder. They cannot: `invoice_id` is NOT NULL and foreign-keyed to
--   `invoices`, and this path raises no invoice — deliberately, because a tax
--   invoice creates a GST liability on money that in this business sometimes
--   never arrives.
--
-- WHY NOT A SECOND TABLE
--   Two logs would mean two answers to "when did we last chase this customer",
--   and the ladder's whole job is not repeating itself. One history, two kinds
--   of subject.
--
-- THE CONSTRAINT IS THE POINT
--   Exactly one of the two must be set. Without it the table grows rows
--   belonging to nothing — invisible in both views, and silently making the
--   ladder think it had already chased something it never did.
-- ============================================================================

alter table public.invoice_dunning_log
  add column if not exists subscription_id uuid
    references public.subscriptions(id) on delete cascade;

-- Drop NOT NULL so a subscription-only chase can be recorded. Existing rows are
-- untouched: every one of them has an invoice_id and keeps it.
alter table public.invoice_dunning_log
  alter column invoice_id drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.invoice_dunning_log'::regclass
       and conname  = 'invoice_dunning_log_one_subject'
  ) then
    alter table public.invoice_dunning_log
      add constraint invoice_dunning_log_one_subject
      check ((invoice_id is not null) <> (subscription_id is not null));
  end if;
end $$;

comment on column public.invoice_dunning_log.subscription_id is
  'Set when the chase is against a POSTPAID SUBSCRIPTION rather than an invoice '
  '(migration 20260910070000). Exactly one of invoice_id / subscription_id is '
  'non-null — see invoice_dunning_log_one_subject. Subscription chases exist '
  'because the postpaid path raises no invoice by design, yet still has a due '
  'date and a balance to pursue.';

comment on column public.invoice_dunning_log.invoice_id is
  'Null when this row logs a subscription chase instead. Was NOT NULL until '
  '10 Sep 2026.';

-- Mirrors invoice_dunning_log_invoice_idx: the cron looks up "the steps already
-- sent for this subject, newest first" on every run, for every candidate.
create index if not exists invoice_dunning_log_subscription_idx
  on public.invoice_dunning_log (subscription_id, sent_at desc)
  where subscription_id is not null;

-- The SELECT policy is tenant-scoped and column-agnostic, so it already covers
-- the new rows. Writes stay service_role only (the cron), which is why there is
-- no INSERT policy to add here.
