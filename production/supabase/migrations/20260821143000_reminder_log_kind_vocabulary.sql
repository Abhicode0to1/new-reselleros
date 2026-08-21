-- ============================================================================
-- 20260821143000 — Use the app's own words for the reminder kind
-- ============================================================================
--
-- The table an hour ago accepted 'checkin' / 'checkout'. The app's own type has always
-- been `ReminderKind = "check_in" | "check_out"` (lib/attendance/reminders.ts:26), so the
-- check constraint disagreed with the only code that would ever write to it — caught by
-- the compiler on the first attempt.
--
-- Fixing the DATABASE rather than mapping in the route, deliberately. A mapping layer
-- between two spellings of the same idea is a place for them to drift: the next person
-- reads one word in the schema and another in the code, and one of the two is wrong in a
-- way nothing checks. There is no data to migrate — the table has never been written to.
--
-- Applied as a follow-up rather than by editing 20260821140000, which is already in the
-- ledger. Editing an applied migration is the drift this repo has been burned by.

begin;

alter table public.attendance_reminder_log
  drop constraint if exists attendance_reminder_log_kind_check;

alter table public.attendance_reminder_log
  add constraint attendance_reminder_log_kind_check
  check (kind in ('check_in', 'check_out'));

comment on column public.attendance_reminder_log.kind is
  'check_in | check_out — the same two values as ReminderKind in lib/attendance/reminders.ts. Kept identical on purpose: a second spelling of the same idea is a place for the schema and the code to drift apart.';

commit;
