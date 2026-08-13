-- 0238 — central outbound email log
--
-- WHY
-- ---
-- Today each feature keeps its own record: renewal_email_log (0008),
-- quote_send_log (0009), compliance_reminder_log (0229). Anything else that
-- sends — payment confirmations, invoice mail, anything added next — leaves no
-- trace at all, because sendEmail() itself writes nothing.
--
-- That is not a gap somebody forgot to fill; it is a design that guarantees the
-- gap widens. A per-feature log is written by whoever remembers, and "who
-- remembers" is the wrong thing for an audit trail to depend on. This table is
-- written from INSIDE sendEmail(), so a caller cannot fail to log by omission.
--
-- WHAT IS DELIBERATELY NOT STORED
-- -------------------------------
-- Not the body, not the HTML, not attachments. This log answers "did we try to
-- email this person, when, through what, and what happened" — it is not an
-- archive of correspondence. Storing bodies would put customer PII and invoice
-- contents in a table that every support query touches, and would grow without
-- bound. The subject is kept because it identifies the message; the content is
-- reproducible from the record it was generated from.
--
-- STATUS IS NOT DELIVERY
-- ----------------------
-- 'sent' means the provider ACCEPTED the message. It does not mean it arrived.
-- Bounces need provider webhooks, which do not exist yet — and Gmail does not
-- report them at all. The column is named `status`, not `delivered`, for that
-- reason, and `delivered_at` is left for when webhooks land rather than faked.
--
-- ⚠️  RUN THE DDL ALONE. A verification SELECT in the same run executes inside
-- the uncommitted transaction and reports success for a change about to roll
-- back. Verify in a SEPARATE run.

begin;

create table if not exists public.email_log (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  recipient   text not null,
  subject     text,
  /** Which message this was — 'renewal_reminder', 'quote', 'invoice', … Free
      text rather than an enum so a new email type cannot fail to be logged
      merely because nobody added it to a type first. */
  kind        text,

  /** Which transport actually carried it, recorded per message: a tenant can
      switch provider between two sends and the log must stay truthful about
      which one each went through. */
  provider    text not null check (provider in ('resend', 'gmail', 'stub')),
  status      text not null check (status in ('sent', 'stubbed', 'failed')),

  /** The provider's own id — the receipt. Without it there is no way to match a
      row here against the provider's dashboard when a customer says they never
      got it. */
  provider_message_id text,
  error_message       text,

  /** Whose action caused it. NULL for cron, which is correct rather than
      missing — nobody pressed anything. */
  user_id     uuid references public.users(id) on delete set null,

  created_at  timestamptz not null default now()
);

-- "What did we send this customer" and "what went out today" are the two real
-- queries; both are tenant-scoped and time-ordered.
create index if not exists email_log_tenant_time_idx
  on public.email_log (tenant_id, created_at desc);

create index if not exists email_log_recipient_idx
  on public.email_log (tenant_id, lower(recipient));

-- Finding failures is the reason anyone opens this table in a hurry.
create index if not exists email_log_failed_idx
  on public.email_log (tenant_id, created_at desc)
  where status <> 'sent';

comment on table public.email_log is
  'Every outbound email attempt, written from inside sendEmail() so no caller can omit it. Bodies are NOT stored. status=sent means the provider accepted the message, not that it was delivered.';

commit;

-- ── BATCH 2 — RLS. Run separately. ──────────────────────────────────────────

begin;

alter table public.email_log enable row level security;

-- Read-only to the tenant. There is no insert/update/delete policy on purpose:
-- rows are written by the server with the service-role key, and a log the
-- subject of the log can edit is not evidence of anything.
drop policy if exists "email_log_select" on public.email_log;
create policy "email_log_select" on public.email_log
  for select using (tenant_id = public.current_tenant_id());

commit;
