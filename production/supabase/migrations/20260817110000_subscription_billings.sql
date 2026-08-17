-- 20260817110000_subscription_billings
--
-- SPLIT INVOICING — one subscription term, many tax invoices.
--
-- ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
-- The app already SELLS this. Pick "Quarterly" in the quote builder and the quote
-- PDF prints, as its grand total:
--
--     Per invoice (4/yr)              ₹7,080/qtr
--     Annual contract value          ₹28,320/yr
--
-- (lib/pdf/QuotePDF.tsx:582-594). The customer signs that. The system then raises
-- ONE invoice for ₹28,320, because generate_invoice is quote-scoped and enforces
-- one quote → one invoice (lib/queries/invoices.ts:125, which lists split-invoicing
-- as a future task). lib/quotes/billing.ts:11-14 says the same in words: the cycle
-- is "a stated schedule/label", nothing generates N invoices.
--
-- So the billing cycle was a promise printed on a signed document and not kept.
-- Checked before building: 1 quote and 1 subscription exist, both yearly, so no
-- customer has been billed wrongly yet. This closes it before the first one is.
--
-- ─── WHAT A ROW IS ──────────────────────────────────────────────────────────
-- One instalment. The forecast that lib/billing/schedule.ts already computes, made
-- durable so it can be billed exactly once. A row exists BEFORE it is invoiced —
-- invoice_id null means "due, not yet raised", and that is the whole state machine.
--
-- ─── THE UNIQUE KEY IS THE IDEMPOTENCY ──────────────────────────────────────
-- (subscription_id, term_start, period_index). A daily cron that re-runs, or runs
-- twice, must not bill a customer twice — and "did we already invoice this period?"
-- has to be answerable by the DATABASE, not by the cron remembering.
--
-- term_start is in the key because period_index restarts at 1 every term. Without
-- it, the first instalment of the renewal term collides with the first instalment
-- of the original term, and the renewal silently never bills.
--
-- ─── WHY THE AMOUNT IS STORED EX-GST ────────────────────────────────────────
-- taxable_amount is what the schedule engine produces (it works from mrr, which is
-- ex-GST), and the gross is derived once when the invoice is raised. Storing both
-- would let them drift, and a stored gross that disagrees with taxable + tax is a
-- GST document that does not add up.

begin;

create table if not exists public.subscription_billings (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  /* Cascade on purpose. An invoice already raised SURVIVES this delete — it is a
     GST document and invoices.id is not a foreign key into here. Only the link is
     lost. Blocking the delete instead would make any subscription that has ever
     billed undeletable, which is the trap migration 0213 already cost us once. */
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,

  /* The term this instalment belongs to — see the header on why it is in the key. */
  term_start      date    not null,
  /* 1-based position within the term, matching BillingPeriod.index. */
  period_index    integer not null,

  /* The date the invoice should be raised. */
  bill_on         date    not null,
  /* The service period this instalment covers — printed on the invoice, and the
     reason a customer can tell two ₹2,360 invoices apart. */
  period_start    date    not null,
  period_end      date    not null,

  /* ₹, EX-GST. Whole rupees, like every other money column (CLAUDE.md §13). */
  taxable_amount  integer not null check (taxable_amount > 0),
  /* Carried per row rather than assumed at 18. A rate change must not retroactively
     alter instalments that were quoted under the old one. */
  tax_rate        integer not null default 18 check (tax_rate between 0 and 100),

  /* Null until raised. This is the state. */
  invoice_id      text references public.invoices(id) on delete set null,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint subscription_billings_period_order check (period_end >= period_start),
  constraint subscription_billings_unique_period
    unique (subscription_id, term_start, period_index)
);

comment on table public.subscription_billings is
  'One instalment of a subscription term. invoice_id null = due but not yet raised. The unique key (subscription_id, term_start, period_index) is what stops the daily cron billing a period twice.';

/* The cron's query: everything due today that has not been raised. */
create index if not exists subscription_billings_due_idx
  on public.subscription_billings (bill_on)
  where invoice_id is null;

create index if not exists subscription_billings_subscription_idx
  on public.subscription_billings (subscription_id, bill_on);

alter table public.subscription_billings enable row level security;

drop policy if exists subscription_billings_select on public.subscription_billings;
create policy subscription_billings_select on public.subscription_billings
  for select using (tenant_id = (select tenant_id from public.users where id = auth.uid()));

/* No insert/update/delete policy. Instalments are materialised from the schedule by
   the billing cron under the service role, and raised by raise_subscription_billing.
   A hand-edited instalment row is a hand-edited tax invoice one step removed. */

-- ─── INVOICES NEED THEIR OWN LINE ITEMS ─────────────────────────────────────
-- An instalment invoice CANNOT carry quote_id. lib/pdf/build-props.ts:69-71 prefers
-- the quote for every amount it prints — `total = quote?.amount ?? invoice.amount` —
-- so linking a ₹2,360 monthly invoice to its ₹28,320 quote would print ₹28,320 on
-- it. The link has to stay null, and the money has to come from the invoice row.
--
-- But build-props.ts:87 also reads line items only from the quote, so a quote-less
-- invoice renders an empty table — and a tax invoice with no description, HSN or
-- quantity does not satisfy CGST Rule 46. Hence this column: the invoice carries its
-- own lines when there is no quote behind it. It also fixes the same empty table on
-- the project-milestone invoices that build-props.ts:49 already mentions.
alter table public.invoices
  add column if not exists line_items jsonb;

comment on column public.invoices.line_items is
  'Line items for an invoice with no backing quote (subscription instalments, project milestones). When quote_id is set the quote''s lines are authoritative and this stays null — see lib/pdf/build-props.ts.';

commit;
