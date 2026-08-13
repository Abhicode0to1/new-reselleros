-- 0229 — reminder log for the statutory-compliance cron (T-15 / T-7 / T-3)
--
-- Safe to paste whole: this is CREATE TABLE + indexes + policies only. Unlike
-- 0228 there is no `alter type`, so nothing here fights the SQL editor's
-- single-transaction execution. Verify afterwards with:
--   select count(*) from public.compliance_reminder_log;
--
-- WHY A DEDICATED TABLE. compliance_log (0201) records FILINGS — the ARN/SRN, the
-- filed date, the acknowledgement. Reminders are a different fact with a
-- different lifetime, and writing them into the filing log would corrupt the one
-- record a CA actually relies on at audit time. They stay apart.
--
-- WHY THE UNIQUE INDEX IS THE REAL GUARD. A daily cron that re-runs — a manual
-- trigger, a retry after a deploy, two instances overlapping — must not email the
-- owner and their CA the same "GSTR-3B due in 7 days" twice. The route checks
-- before sending, but a check-then-write is a race; the constraint is what makes
-- a duplicate impossible rather than unlikely. One row per
-- (tenant, obligation, period, days_before, recipient) is exactly one reminder.
--
-- Nothing here is destructive and the table starts empty, so applying it changes
-- no existing behaviour: the cron simply has somewhere to record what it sent.

create table if not exists public.compliance_reminder_log (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  -- Obligation.key from src/lib/compliance/obligations.ts (e.g. 'roc_aoc4').
  obligation_key  text not null,
  -- ComplianceInstance.periodKey (e.g. 'fy2025', '2026-07') — the period the
  -- reminder was about, so next year's reminder is a different row.
  period_key      text not null,
  -- 15, 7 or 3. Stored rather than derived so a change to the ladder later
  -- cannot retroactively re-open reminders already sent.
  days_before     integer not null check (days_before > 0 and days_before <= 90),
  recipient_email text not null,
  -- Mirrors renewal_email_log so both send paths report the same way.
  status          text not null check (status in ('sent','stubbed','failed','skipped')),
  provider_id     text,
  error_message   text,
  sent_at         timestamptz not null default now()
);

-- The idempotency guard. Case-insensitive on the address so Owner@x.com and
-- owner@x.com are one recipient, not two.
create unique index if not exists compliance_reminder_log_uq
  on public.compliance_reminder_log (tenant_id, obligation_key, period_key, days_before, lower(recipient_email));

create index if not exists compliance_reminder_log_tenant_time_idx
  on public.compliance_reminder_log (tenant_id, sent_at desc);

alter table public.compliance_reminder_log enable row level security;

-- Readable by the tenant (so the page can show "reminded on …"), never writable
-- from a client: only the cron's service-role connection inserts. Same shape as
-- the activity log — nobody can forge or erase a reminder trail.
drop policy if exists compliance_reminder_log_sel on public.compliance_reminder_log;
create policy compliance_reminder_log_sel on public.compliance_reminder_log
  for select to authenticated using (tenant_id = public.current_tenant_id());

comment on table public.compliance_reminder_log is
  'One row per statutory reminder actually sent. Unique on (tenant, obligation, period, days_before, lower(email)) so a cron re-run cannot duplicate a reminder.';
