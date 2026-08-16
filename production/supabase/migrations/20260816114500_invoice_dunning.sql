-- 20260816114500_invoice_dunning
--
-- WHAT THIS ADDS
--   `invoice_dunning_log`      — one row per dunning message sent for an invoice.
--   `tenants.auto_suspend_on_overdue` — opt-in for the Day-14 automatic suspension.
--
-- WHY A SEPARATE LOG FROM renewal_email_log
--   They chase different things on different clocks. renewal_email_log records counting
--   DOWN to a subscription's renewal_date; this records counting UP from an invoice's
--   due_date. A customer can be perfectly current on renewals and two weeks late on a
--   one-off invoice, and the reverse. One table keyed on subscription_id could not
--   record the second case at all, and sharing it would make "have we chased this
--   already?" ambiguous — which is the one question a dunning log exists to answer.
--
-- WHY auto_suspend_on_overdue DEFAULTS TO FALSE
--   Suspending means a customer's staff cannot read email. It is the most damaging
--   thing this software can do to an end user, it is done to people who are not the
--   software's customer, and it is undone only by a human noticing.
--
--   Driving it from an unpaid-INVOICE clock would cut off a live subscription because
--   an unrelated one-off invoice went unpaid — a hosting bill, a support charge — and
--   the first anyone would hear of it is a customer who cannot log in. Suspension
--   already has an owner: the renewal engine, which knows the subscription lifecycle
--   and the grace period.
--
--   So the column exists, the behaviour is implemented, and it is OFF until a reseller
--   decides otherwise. Even when on, lib/invoices/dunning.ts refuses to suspend an
--   invoice that is not linked to a subscription — there is nothing to suspend.
--
-- HOW TO VERIFY (SEPARATE run from the DDL — AGENTS.md §5):
--
--   select count(*) from public.invoice_dunning_log;          -- expect 0
--   select count(*) from public.tenants where auto_suspend_on_overdue;  -- expect 0
--   select policyname from pg_policies where tablename='invoice_dunning_log';

begin;

create table if not exists public.invoice_dunning_log (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  invoice_id    text not null references public.invoices(id) on delete cascade,
  /* 'reminder' | 'retry' | 'grace_warning' | 'final' — kept as text, matching
     lib/invoices/dunning.ts. Not an enum: the schedule is a business decision the
     reseller may want to change, and a migration per tweak is friction that ends with
     people not tweaking it. */
  dunning_step  text not null,
  days_overdue  integer not null,
  /* 'email' | 'escalate' | 'suspend' — what was actually DONE, which is not always
     what the step implies (see auto_suspend_on_overdue above). */
  action_taken  text not null default 'email',
  recipient_email text,
  subject       text,
  status        text not null default 'sent',
  error_message text,
  sent_at       timestamptz not null default now()
);

comment on table public.invoice_dunning_log is
  'One row per dunning message for an overdue invoice. Separate from renewal_email_log because that counts DOWN to a renewal and this counts UP from a due date — a customer can be current on one and late on the other.';
comment on column public.invoice_dunning_log.action_taken is
  'What was DONE, not what the step implies. A Day-14 step records "escalate" unless the tenant opted into automatic suspension AND the invoice bills a subscription.';

-- The cron asks "what have we already sent for this invoice?" — that is the whole
-- idempotency check, so it is the index.
create index if not exists invoice_dunning_log_invoice_idx
  on public.invoice_dunning_log (invoice_id, sent_at desc);
create index if not exists invoice_dunning_log_tenant_idx
  on public.invoice_dunning_log (tenant_id, sent_at desc);

alter table public.invoice_dunning_log enable row level security;

drop policy if exists invoice_dunning_log_select on public.invoice_dunning_log;
create policy invoice_dunning_log_select on public.invoice_dunning_log
  for select
  using (tenant_id = (select tenant_id from public.users where id = auth.uid()));

alter table public.tenants
  add column if not exists auto_suspend_on_overdue boolean not null default false;

comment on column public.tenants.auto_suspend_on_overdue is
  'Opt-in: suspend a subscription automatically when its invoice is 14 days overdue. FALSE by default on purpose — see the migration header. Off means the reseller is escalated to instead.';

commit;
