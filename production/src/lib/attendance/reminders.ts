/**
 * When should the attendance popup appear — and, just as importantly, when must it not?
 *
 * ─── WHAT WAS ASKED FOR ─────────────────────────────────────────────────────
 * Two nudges, from a report filed on /attendance/me:
 *   "Computer ko open karte hi user ko attendance ka popup mil jaye jisse wo attendance
 *    miss na kare, iske saath hi 6 baje (ya time set karne ka option) ek Check Out Popup
 *    Reminder hona chahiye, taki user Check out bhi miss na kare."
 *
 * ─── WHY THE DECISION LIVES HERE AND NOT IN THE COMPONENT ───────────────────
 * A popup that appears at the wrong moment is worse than no popup: people learn to
 * dismiss it without reading, and then it fails on the day it is right. Every "should it
 * show" rule is therefore a pure function of explicit inputs, so each one can be tested
 * at a chosen minute of a chosen day instead of by waiting until 18:00 and watching.
 *
 * ─── EVERYTHING IS IST, DELIBERATELY ────────────────────────────────────────
 * `my_attendance_today` decides "today" in Asia/Kolkata, so the client has to as well. If
 * the popup used the browser's local midnight, a laptop left on a foreign timezone would
 * ask somebody to check in for a day the database has already closed — and it would look
 * like the reminder was simply broken rather than an hour out.
 */

/** Minutes past IST midnight before which a check-in nudge is just noise. */
export const CHECKIN_WINDOW_START_MIN = 6 * 60; // 06:00

export type ReminderKind = "check_in" | "check_out";

export interface ReminderDecision {
  kind: ReminderKind | null;
  /** Why — surfaced in tests and useful when somebody asks "why didn't it fire". */
  reason: string;
}

export interface IstNow {
  /** Minutes past midnight, Asia/Kolkata. */
  minutes: number;
  /** YYYY-MM-DD in Asia/Kolkata. The key everything per-day is stored under. */
  date: string;
}

/**
 * Read the current IST wall clock off a real Date.
 *
 * Uses `Intl` with an explicit timeZone rather than any offset arithmetic. India has no
 * DST so a fixed +5:30 would work today, but a hardcoded offset is the kind of thing that
 * is right until it silently is not, and `en-CA` gives an ISO-shaped date for free.
 */
export function istNow(now: Date): IstNow {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  const hhmm = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);

  const [h, m] = hhmm.split(":").map(Number);
  return { minutes: h * 60 + m, date };
}

/**
 * "18:00" / "18:00:00" / "18:00:00+05:30" → 1080.
 *
 * Postgres `time` arrives from PostgREST as "18:00:00", and a hand-typed value from an
 * `<input type="time">` as "18:00". Returns null for anything it cannot read, so a
 * corrupt preference disables the reminder rather than firing it at midnight — the
 * failure that would teach people to ignore the popup.
 */
export function parseTimeToMinutes(value: string | null | undefined): number | null {
  const v = (value ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 1080 → "18:00". For rendering the setting back to the person who set it. */
export function minutesToTimeValue(minutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export interface ReminderInput {
  now: IstNow;
  /** False when this login has no employee row — there is nothing to check in to. */
  linked: boolean;
  /** ISO timestamps from `my_attendance_today`, or null. */
  checkIn: string | null;
  checkOut: string | null;
  enabled: boolean;
  /** From `users.attendance_checkout_reminder_at`. */
  checkoutReminderAt: string | null;
  /** IST date (YYYY-MM-DD) this kind was last dismissed for. */
  dismissed?: Partial<Record<ReminderKind, string | null>>;
  /** Minutes-past-IST-midnight until which the user snoozed, for `now.date`. */
  snoozedUntilMin?: number | null;
  /** True while the person is already looking at /attendance/me. */
  onAttendanceScreen?: boolean;
  /**
   * Why today is not a working day, or null when it is — from
   * `lib/attendance/working-day.ts`.
   *
   * Reported 23 Aug 2026 (a Sunday): this file had NO notion of a working day, so the
   * nudge went out every Sunday and on every public holiday, even though
   * `public.holidays` has stored them all along. A notification that arrives on the wrong
   * day teaches people to dismiss it unread — and then it stops working on the day it is
   * right, which is the only day it was built for.
   *
   * Computed by the CALLER rather than here, because the answer needs the tenant's
   * holiday rows and its week shape, and this function is deliberately pure — the popup
   * and the cron share it, and two copies of "is somebody due a nudge" would drift within
   * a month.
   */
  nonWorkingDayReason?: string | null;
}

/**
 * Should a reminder show right now, and which one?
 *
 * The order of the guards is the design. Everything that means "never show" is checked
 * before anything that means "show", so a person who switched the feature off cannot be
 * reached by a later rule, and the day-complete case beats every nudge.
 */
export function decideAttendanceReminder(input: ReminderInput): ReminderDecision {
  const { now, linked, checkIn, checkOut, enabled } = input;

  if (!enabled) return { kind: null, reason: "Reminders are switched off for this person." };

  /* Before anything about this person: nobody is due a check-in on a day the company is
     closed. Placed here, with the other "never show" guards, because the order of these
     is the design — see the note above the function. */
  if (input.nonWorkingDayReason) {
    return { kind: null, reason: input.nonWorkingDayReason };
  }

  if (!linked) {
    // A login with no employee row cannot punch at all. Nagging them to do something the
    // app will refuse is how a reminder becomes a thing people close without reading.
    return { kind: null, reason: "This login is not linked to an employee record." };
  }

  if (checkOut) return { kind: null, reason: "Already checked out — the day is complete." };

  if (input.onAttendanceScreen) {
    // They are looking at the check-in button. A modal over it adds a click and removes
    // nothing.
    return { kind: null, reason: "Already on the attendance screen." };
  }

  if (input.snoozedUntilMin != null && now.minutes < input.snoozedUntilMin) {
    return { kind: null, reason: "Snoozed." };
  }

  const checkoutAt = parseTimeToMinutes(input.checkoutReminderAt);

  if (!checkIn) {
    if (now.minutes < CHECKIN_WINDOW_START_MIN) {
      return { kind: null, reason: "Too early — before the check-in window opens." };
    }
    // Past the time they said they finish, "you haven't checked in" is no longer a useful
    // nudge; the day is effectively gone and the message reads as an accusation. The
    // check-out reminder does not apply either, because there is no check-in to close.
    if (checkoutAt != null && now.minutes >= checkoutAt) {
      return { kind: null, reason: "Past the end of the working day with no check-in — too late to nudge." };
    }
    if (input.dismissed?.check_in === now.date) {
      return { kind: null, reason: "Check-in reminder already dismissed today." };
    }
    return { kind: "check_in", reason: "Not checked in yet." };
  }

  // Checked in, not out.
  if (checkoutAt == null) {
    // An unreadable preference must not become a midnight popup.
    return { kind: null, reason: "No usable check-out reminder time is configured." };
  }
  if (now.minutes < checkoutAt) {
    return { kind: null, reason: "Not yet the configured check-out time." };
  }
  if (input.dismissed?.check_out === now.date) {
    return { kind: null, reason: "Check-out reminder already dismissed today." };
  }
  return { kind: "check_out", reason: "Checked in, past the configured check-out time." };
}

/** localStorage key for the per-day dismissal. Per user, so a shared laptop does not leak. */
export function dismissKey(userId: string, kind: ReminderKind): string {
  return `attendance-reminder:${userId}:${kind}:dismissed-on`;
}

/** localStorage key for a snooze, scoped to one IST day. */
export function snoozeKey(userId: string, date: string): string {
  return `attendance-reminder:${userId}:${date}:snooze-until-min`;
}
