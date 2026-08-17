-- 20260817210000_dunning_pre_due_comments
--
-- Comments only. No schema change, and that is the point worth recording.
--
-- ─── THE LADDER NOW STARTS BEFORE THE DUE DATE ──────────────────────────────
-- lib/invoices/dunning.ts gained two steps on 17 Aug 2026: `pre_due` (3 to 1 days
-- BEFORE due) and `due_today`. Neither needed a migration, because
-- `invoice_dunning_log.dunning_step` was deliberately left as `text` with no CHECK
-- constraint — the original migration's comment says the schedule is a business
-- decision the reseller may want to change, and a migration per tweak is friction that
-- ends with nobody tweaking it. That call paid off today.
--
-- ─── BUT days_overdue CAN NOW BE NEGATIVE, AND A READER MUST KNOW ───────────
-- A pre-due row logs `days_overdue = -3`, meaning three days of runway LEFT. The column
-- is `integer` so it already stores this fine. The risk is a human or a report reading
-- `-3` as "3 days late" and chasing a customer who is not late — or a future
-- `where days_overdue > 0` filter silently dropping every pre-due row from an aging
-- report without anybody noticing the gap.
--
-- Documented here rather than renamed: renaming the column would break the cron and
-- every existing row's meaning, to fix a sign convention that is correct once stated.

begin;

comment on column public.invoice_dunning_log.dunning_step is
  'Which rung of the ladder this message was: pre_due | due_today | reminder | retry | grace_warning | final. Kept as text with NO check constraint — the schedule is a business decision the reseller may want to change, and a migration per tweak is friction that ends with people not tweaking it. Ordering lives in dunningRank() in lib/invoices/dunning.ts, which is exported precisely so the cron cannot keep a second copy that drifts.';

comment on column public.invoice_dunning_log.days_overdue is
  'Days past the due date — and NEGATIVE before it. -3 means three days of runway still left (a pre_due nudge), 0 means due today, 5 means five days late. Read the sign: a filter of `days_overdue > 0` excludes every pre-due and due-today row, which is right for an aging report and wrong for "what did we send this customer".';

commit;
