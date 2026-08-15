-- 0046_leads_workflow_fields.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Lead entry workflow upgrade
--
-- Sales reps need three pieces of info on every lead that the schema didn't
-- previously capture:
--
--   follow_up_date  date         → next planned contact. Drives daily
--                                   "who do I call today" worklist + cron
--                                   reminder pings.
--   priority        text         → triage signal. 'low' / 'medium' / 'high'.
--                                   Default 'medium'.
--   gstin           text         → B2B qualification. Once captured, the
--                                   existing Sandbox.co.in verifier can
--                                   auto-fill the company's legal name +
--                                   registered address when the lead
--                                   converts to a customer.
--
-- All three are nullable so existing rows + downstream code keep working.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.leads
  add column if not exists follow_up_date date,
  add column if not exists priority       text not null default 'medium'
    check (priority in ('low', 'medium', 'high')),
  add column if not exists gstin          text;

create index if not exists idx_leads_follow_up_date
  on public.leads(follow_up_date)
  where follow_up_date is not null;

create index if not exists idx_leads_priority
  on public.leads(priority)
  where priority <> 'medium';
