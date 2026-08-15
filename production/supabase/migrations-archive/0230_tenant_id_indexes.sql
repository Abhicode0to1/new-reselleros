-- 0230 — tenant_id indexes on the tables that will grow
--
-- Safe to paste whole: CREATE INDEX IF NOT EXISTS only, no data touched, and
-- every target table currently holds fewer than 50 rows so each one builds
-- instantly. Verify afterwards with the query at the bottom.
--
-- ─── WHY, AND WHY ONLY THESE ────────────────────────────────────────────────
-- Every RLS policy on this database filters `tenant_id = current_tenant_id()`,
-- so tenant_id is on the critical path of literally every authenticated read.
-- An audit of the 70 tables carrying tenant_id found 19 with no index leading
-- on it — meaning a sequential scan on each of those, on every query.
--
-- That is NOT a problem today. Measured against production: the largest of them
-- holds 42 rows, and the heaviest dashboard reads return in 70–118ms, which is
-- almost entirely network round-trip to Supabase rather than query time. Adding
-- indexes to a 42-row table buys nothing; Postgres would seq-scan anyway because
-- it is cheaper than an index lookup at that size.
--
-- The reason to do it now is that adding an index LATER is the expensive
-- version. On a table with real volume, CREATE INDEX takes a write lock, so it
-- needs CONCURRENTLY, which cannot run inside a transaction, which means another
-- careful single-statement migration under load. Right now every one of these
-- builds in milliseconds with nothing to lock.
--
-- Excluded deliberately: attendance_settings, tenant_secrets, customer_groups,
-- customer_number_seq, user_google_tokens, team_invites, backup. Those hold one
-- or a handful of rows PER TENANT by design and will never grow with usage — an
-- index there is pure write overhead for a scan of three rows.
--
-- ─── COMPOSITE, NOT tenant_id ALONE ─────────────────────────────────────────
-- Every list view in the app filters by tenant and orders by created_at desc.
-- A composite (tenant_id, created_at desc) serves both the filter and the sort
-- from one index, so Postgres can skip the sort entirely. It also still serves a
-- plain tenant_id lookup, because tenant_id leads. Same storage, strictly more
-- useful — verified that all twelve tables carry created_at.

create index if not exists lead_activities_tenant_time_idx
  on public.lead_activities (tenant_id, created_at desc);

create index if not exists inbound_emails_tenant_time_idx
  on public.inbound_emails (tenant_id, created_at desc);

create index if not exists project_sales_tenant_time_idx
  on public.project_sales (tenant_id, created_at desc);

create index if not exists project_tasks_tenant_time_idx
  on public.project_tasks (tenant_id, created_at desc);

create index if not exists project_milestones_tenant_time_idx
  on public.project_milestones (tenant_id, created_at desc);

create index if not exists project_payments_tenant_time_idx
  on public.project_payments (tenant_id, created_at desc);

create index if not exists project_labour_tenant_time_idx
  on public.project_labour (tenant_id, created_at desc);

create index if not exists emi_payments_tenant_time_idx
  on public.emi_payments (tenant_id, created_at desc);

create index if not exists business_loan_payments_tenant_time_idx
  on public.business_loan_payments (tenant_id, created_at desc);

create index if not exists employee_loan_repayments_tenant_time_idx
  on public.employee_loan_repayments (tenant_id, created_at desc);

create index if not exists leave_entries_tenant_time_idx
  on public.leave_entries (tenant_id, created_at desc);

-- renewal_email_log already has (subscription_id, cadence_step, sent_at) for the
-- cron's idempotency check. This one serves the opposite direction: "show me
-- everything this tenant was sent", which the cron also runs once per tenant per
-- day and which today scans the whole table.
create index if not exists renewal_email_log_tenant_time_idx
  on public.renewal_email_log (tenant_id, sent_at desc);

-- ─── VERIFY IN A SEPARATE RUN ───────────────────────────────────────────────
-- select tablename, indexname from pg_indexes
--  where schemaname = 'public' and indexname like '%_tenant_time_idx'
--  order by tablename;
-- Expect 12 rows (plus compliance_reminder_log's, added by 0229).
