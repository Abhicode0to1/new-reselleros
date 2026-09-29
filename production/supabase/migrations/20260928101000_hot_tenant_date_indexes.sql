-- ============================================================================
-- S14 — (tenant_id, date) indexes on the tables every list view and report reads.
--
-- ─── WHY ─────────────────────────────────────────────────────────────────────
-- migrations-archive/0230_tenant_id_indexes.sql was written but never reached the
-- database that baseline.sql was dumped from: none of its 12 indexes are in baseline.sql
-- or in any later migration (checked 28 Sep 2026 with grep, and against the local replica's
-- pg_indexes). On top of that, the four hottest date-filtered tables have no index that
-- leads on tenant_id AND carries the date the app filters/sorts by:
--     leads     — every list orders by created_at            (only partial (tenant, created_at) ones exist)
--     invoices  — GST/ledger reports range on invoice_date    (only (tenant_id, status))
--     payments  — cash reports range on received_at           (only (tenant_id) and (received_at))
--     quotes    — lists order by created_date                 (only (tenant_id), (tenant_id, status))
--     lead_activities — no tenant_id index at all             (covered by 0230's index below)
--
-- Composite (tenant_id, <date> desc): tenant_id leads, so it serves the RLS tenant filter
-- AND the range/sort in one index, and still serves a plain tenant_id lookup. The existing
-- single-column tenant indexes (payments_tenant_idx, idx_quotes_tenant) become redundant;
-- they are NOT dropped here — dropping is a separate, measured decision.
--
-- From 0230, deliberately left out: inbound_emails_tenant_time_idx. Since 0230 was written
-- inbound_emails gained inbox/route/starred/pending-bill indexes that all lead on
-- (tenant_id, …, created_at desc) — another one would be pure write overhead.
--
-- ─── WHY NOT CONCURRENTLY HERE, AND WHAT TO DO ON PRODUCTION ─────────────────
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and migration runners
-- (supabase db push, and the begin … rollback regression test) wrap each file in one. So
-- this file uses plain CREATE INDEX IF NOT EXISTS, which takes a SHARE lock: writes to that
-- table wait until the build finishes; reads are not blocked. At today's row counts that is
-- milliseconds.
--
-- If a table has grown large by the time this ships (rule of thumb: > ~100k rows, or any
-- doubt), apply that statement MANUALLY first, one statement per call, outside a transaction:
--     create index concurrently if not exists leads_tenant_created_idx
--       on public.leads (tenant_id, created_at desc);
-- …then run this migration: IF NOT EXISTS makes the already-built ones no-ops. After a
-- CONCURRENTLY build, confirm it is valid (a failed concurrent build leaves an INVALID index
-- that IF NOT EXISTS would then silently skip):
--     select indexrelid::regclass from pg_index where not indisvalid;   -- expect 0 rows
-- ============================================================================

-- ─── Hot tables: (tenant_id, date) ──────────────────────────────────────────
create index if not exists leads_tenant_created_idx
  on public.leads (tenant_id, created_at desc);

create index if not exists invoices_tenant_invoice_date_idx
  on public.invoices (tenant_id, invoice_date desc);

create index if not exists payments_tenant_received_idx
  on public.payments (tenant_id, received_at desc);

create index if not exists quotes_tenant_created_date_idx
  on public.quotes (tenant_id, created_date desc);

-- ─── From migrations-archive/0230 (names kept, so a DB that did run 0230 no-ops) ──
create index if not exists lead_activities_tenant_time_idx
  on public.lead_activities (tenant_id, created_at desc);

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

create index if not exists renewal_email_log_tenant_time_idx
  on public.renewal_email_log (tenant_id, sent_at desc);

-- ─── VERIFY IN A SEPARATE RUN ───────────────────────────────────────────────
--   select tablename, indexname from pg_indexes
--    where schemaname = 'public'
--      and (indexname like '%\_tenant\_time\_idx' or indexname in (
--           'leads_tenant_created_idx','invoices_tenant_invoice_date_idx',
--           'payments_tenant_received_idx','quotes_tenant_created_date_idx'))
--    order by 1;
