-- 20260819150000_attendance_reminder_prefs
--
-- Two per-person settings behind the attendance check-in / check-out reminder.
--
-- ─── WHY THIS IS ON `users` AND NOT ON `employees` ──────────────────────────
-- Attendance itself belongs to `employees` — that is who is present and who gets paid.
-- But a REMINDER is a property of the person sitting at the browser, and the browser
-- session is a `users` row. An employee with no login cannot be reminded by a popup at
-- all, so hanging the setting off `employees` would create rows that can never do
-- anything. `my_attendance_today` already bridges the two.
--
-- ─── WHY THE TIME IS STORED AND NOT KEPT IN THE BROWSER ─────────────────────
-- localStorage would have avoided this migration entirely, and for the DISMISSED /
-- SNOOZED state that is exactly what is used — that is per-device scratch that should
-- expire. But the reporter asked for "time set karne ka option ki kitne baje Check out
-- karna hai", which is a setting a person configures once and expects to still hold when
-- they open the app on their phone. A preference that silently resets on a second device
-- reads as the feature being broken.
--
-- ─── THE DEFAULT IS 18:00, AND IT IS NOT DERIVED FROM ANYTHING ──────────────
-- Checked before choosing it: there is no shift, office-hours, or working-window column
-- anywhere in this schema (searched every column matching shift / work_start / work_end /
-- office_hour). So there was nothing to inherit from, and 18:00 is the reporter's own
-- suggestion — "Attendance me 6 baje". Recorded as a decision rather than left looking
-- like a derived value, because the day office hours DO get modelled, this default should
-- move rather than be duplicated.
--
-- ─── SAFE UNDER THE PRIVILEGED-COLUMN GUARD ─────────────────────────────────
-- `users_privileged_columns_guard` (20260818160000, verified present on prod) returns
-- early unless role / manager_id / can_view_deals / tenant_id / is_active changed. Neither
-- column below is one of those, so a person editing their own reminder time passes the
-- trigger and is allowed through by the existing `users_self_update` policy
-- (`id = auth.uid()`). No policy or trigger change is needed, and none is made.

begin;

alter table public.users
  add column if not exists attendance_reminders_enabled boolean not null default true,
  /* `time` and not `timestamptz`: this is a wall-clock time of day that means the same
     thing every day, not an instant. Interpreted in Asia/Kolkata by
     lib/attendance/reminders.ts — the app has no other timezone. */
  add column if not exists attendance_checkout_reminder_at time not null default '18:00';

comment on column public.users.attendance_reminders_enabled is
  'Whether this person sees the attendance check-in / check-out popup. Default true: the reminder exists because people were missing punches, so it has to be on for the people who have not thought about it yet. Anyone can turn their own off from /attendance/me.';
comment on column public.users.attendance_checkout_reminder_at is
  'Wall-clock time (Asia/Kolkata) after which an un-checked-out person is reminded. Default 18:00, taken from the request that asked for this; NOT derived from an office-hours setting, because this schema does not have one.';

commit;

-- ─── VERIFY (separate run — CLAUDE.md §25.6) ────────────────────────────────
-- select column_name, data_type, column_default, is_nullable
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'users'
--    and column_name in ('attendance_reminders_enabled', 'attendance_checkout_reminder_at');
-- -- expect 2 rows: boolean/true/NO and time without time zone/'18:00:00'/NO
