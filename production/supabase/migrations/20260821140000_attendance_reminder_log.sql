-- ============================================================================
-- 20260821140000 — One attendance reminder per person, per day, per kind
-- ============================================================================
--
-- ─── WHY A TABLE AND NOT CAREFUL SCHEDULING ─────────────────────────────────
-- The cron will run every half hour, Cloud Scheduler retries on a non-2xx, and a deploy
-- can overlap two invocations. Any of those sends a second reminder for the same day, and
-- a phone that buzzes about the same missed check-in four times does not get four
-- reminders — it gets its notifications switched off, which costs every future reminder
-- as well. Timing cannot prevent that; a UNIQUE constraint can.
--
-- So the unique index IS the feature. `(user_id, work_date, kind)` means the second
-- attempt fails at the database rather than at the phone.
--
-- ─── THE SLOT IS CLAIMED BEFORE THE PUSH IS SENT ────────────────────────────
-- Insert first, then send. If the push then fails, that person has lost today's reminder;
-- the row records why. The other order — send, then record — loses the row on any crash
-- between the two and buzzes again on the next run.
--
-- That is a deliberate trade in favour of the quieter failure: a reminder that did not
-- arrive is a bad day, while a reminder that arrives five times is the end of
-- notifications for that person. It is also why `sent_at` is nullable and `error` exists:
-- a run that claimed a slot and failed is visible, instead of looking like a day nobody
-- was due.
--
-- ─── NO RLS POLICIES, AND THAT IS NOT AN OVERSIGHT ──────────────────────────
-- RLS is ENABLED with no policy, so no browser session can read or write this table at
-- all. Only the service role (the cron) touches it. This is bookkeeping about
-- notifications, not something a user needs to see, and the safest shape for a table
-- nobody should reach is one nobody can.

begin;

create table if not exists public.attendance_reminder_log (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  user_id    uuid not null references public.users(id)   on delete cascade,
  /** The IST calendar date the reminder was for — not the timestamp it ran. */
  work_date  date not null,
  /** 'checkin' | 'checkout' — the same two kinds the client-side reminder uses. */
  kind       text not null check (kind in ('checkin', 'checkout')),
  claimed_at timestamptz not null default now(),
  /** Null means the slot was claimed but the push did not go out. */
  sent_at    timestamptz,
  devices    integer not null default 0,
  error      text
);

-- The guarantee. Everything above is bookkeeping; this line is what stops the fourth buzz.
create unique index if not exists attendance_reminder_log_once
  on public.attendance_reminder_log (user_id, work_date, kind);

alter table public.attendance_reminder_log enable row level security;

comment on table public.attendance_reminder_log is
  'One row per person per day per reminder kind. The unique index is the point: it makes a repeated cron run, a Scheduler retry and an overlapping deploy all harmless. Service-role only — RLS is on with no policies on purpose.';

commit;
