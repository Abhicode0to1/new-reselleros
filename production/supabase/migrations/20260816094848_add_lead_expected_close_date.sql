-- 20260816094848_add_lead_expected_close_date
--
-- WHAT THIS CHANGES
--   Adds `leads.expected_close_date` (a DATE) — when the rep expects the deal to land.
--
-- WHY
--   Open Pipeline today sums every open deal at full value. That answers "how much is in
--   play" and is useless for "how much will land this month": a ₹5L deal at `new` and a
--   ₹5L deal at `quote` are counted identically, and neither carries a date.
--
--   With a close date and the per-stage probabilities in lib/leads/forecast.ts, the same
--   pipeline produces a weighted forecast AND can be cut by month. Without the date, a
--   forecast can only ever say "eventually" — which is not a forecast.
--
--   Nullable on purpose. Most existing leads have no date and nobody should invent one;
--   buildForecast() reports the undated count separately rather than hiding those deals
--   or guessing at them.
--
--   NOT a generated/derived column: the close date is the rep's judgement about a
--   specific customer, and no formula over stage or created_at can stand in for it.
--
-- HOW TO VERIFY (run in a SEPARATE run from the DDL — a SELECT inside the same
-- transaction sees uncommitted changes and reports success for a change about to roll
-- back; see AGENTS.md §5):
--
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'leads'
--      and column_name = 'expected_close_date';
--
--   Expect exactly one row: expected_close_date | date | YES

begin;

alter table public.leads
  add column if not exists expected_close_date date;

comment on column public.leads.expected_close_date is
  'When the rep expects this deal to close. NULL means nobody has committed to a date — reported as "undated" in the forecast, never guessed. Drives the weighted forecast in lib/leads/forecast.ts.';

/* Partial index: forecast queries always filter to open, dated deals, and the undated
   rows are the majority today. Indexing only the dated ones keeps it small. */
create index if not exists leads_expected_close_date_idx
  on public.leads (tenant_id, expected_close_date)
  where expected_close_date is not null;

commit;
