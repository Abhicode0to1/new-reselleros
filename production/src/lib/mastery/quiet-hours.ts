/**
 * Burnout protection — quiet hours for outbound notifications.
 *
 * ─── THIS IS NOT HYPOTHETICAL ────────────────────────────────────────────────
 * `scripts/setup-cloud-scheduler.sh` schedules `resellersos-birthday-greetings`
 * at `1 21 * * *` Asia/Kolkata — **21:01 IST**. Today that job's emails are
 * stubbed because RESEND_API_KEY is absent, so nothing lands. The day that key
 * is set, this app starts emailing staff and customers at nine at night, and
 * nobody will have decided that. `RESEND_API_KEY` is the top of the open list, so
 * this is a near-term event, not a distant one.
 *
 * ─── WHITE HAT, WHICH MEANS SUPPRESSION IS NOT DELETION ──────────────────────
 * The brief asks to "automatically silence high-stress notifications after 7 PM
 * and on weekends". Silencing must never mean dropping: a renewal notice that is
 * swallowed instead of deferred turns a motivation feature into a money bug — the
 * cadence would record a reminder as handled while the customer heard nothing.
 * `quietHoursDecision` therefore returns **defer with a send-after timestamp**,
 * never "discard". The caller queues; it does not bin.
 *
 * ─── WHAT IS EXEMPT, AND WHY ─────────────────────────────────────────────────
 * Not everything may wait. A payment receipt is what a customer refreshes their
 * inbox for at 9 PM; holding it looks broken. An OTP or password reset is useless
 * tomorrow morning. So urgency is a property of the MESSAGE, not of the clock,
 * and the exempt list is explicit rather than a default-allow.
 */

/** Message classes the send paths can label themselves with. */
export type NotificationClass =
  /** Renewal cadence, statutory reminders, dunning — the stressful ones. */
  | "reminder"
  /** Leaderboard, badges, kudos, streaks — nice, and never urgent. */
  | "gamification"
  /** Birthday and anniversary greetings — the 21:01 job. */
  | "greeting"
  /** Digest and report emails. */
  | "digest"
  /** Payment received, invoice issued — the recipient is waiting for it. */
  | "transactional"
  /** OTP, password reset, security alert — useless if delayed. */
  | "security";

/** Classes that are NEVER held back. Everything else is subject to quiet hours. */
const ALWAYS_SEND: ReadonlySet<NotificationClass> = new Set<NotificationClass>([
  "transactional",
  "security",
]);

/** Quiet from this hour (IST, inclusive) until QUIET_END_HOUR next morning. */
export const QUIET_START_HOUR = 19; // 7 PM
export const QUIET_END_HOUR   = 9;  // 9 AM

const IST_OFFSET_MS = 5.5 * 3_600_000;

/** IST wall-clock parts for an instant. IST has no DST, so a fixed offset is exact. */
export function istParts(at: Date): { hour: number; minute: number; weekday: number; ymd: string } {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return {
    hour: ist.getUTCHours(),
    minute: ist.getUTCMinutes(),
    // 0 = Sunday … 6 = Saturday
    weekday: ist.getUTCDay(),
    ymd: ist.toISOString().slice(0, 10),
  };
}

/** Saturday or Sunday in IST. */
export function isWeekendIST(at: Date): boolean {
  const d = istParts(at).weekday;
  return d === 0 || d === 6;
}

/** Inside the nightly quiet window in IST. */
export function isNightIST(at: Date): boolean {
  const h = istParts(at).hour;
  // The window wraps midnight, so it is "at or after 19" OR "before 9".
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

export type QuietReason = "night" | "weekend" | null;

export interface QuietDecision {
  /** true = send now. false = hold until `sendAfter`. */
  send: boolean;
  reason: QuietReason;
  /** When it becomes sendable. null when sending now. */
  sendAfter: Date | null;
  /** Plain-language explanation for a log line or an admin screen. */
  explanation: string;
}

/**
 * The next moment this message may be sent.
 *
 * Weekends resolve to Monday 09:00 IST, nights to 09:00 IST the same or next
 * morning. Computed rather than approximated, because "roughly tomorrow" is how
 * a queue ends up firing at 03:00.
 */
function nextOpenWindow(at: Date): Date {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);

  // Start from 09:00 IST today, then walk forward until it is both a weekday and
  // at/after the current instant.
  const candidate = new Date(Date.UTC(
    ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), QUIET_END_HOUR, 0, 0
  ));
  // Before 09:00 IST the same morning still works; otherwise move to tomorrow.
  if (ist.getTime() >= candidate.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  // Skip Saturday (6) and Sunday (0).
  while (candidate.getUTCDay() === 0 || candidate.getUTCDay() === 6) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return new Date(candidate.getTime() - IST_OFFSET_MS);
}

/**
 * Should this message go out right now?
 *
 * @param cls The message class. `transactional` and `security` always send.
 * @param at  The instant to judge. Pass it explicitly so this stays pure and
 *            testable — a function that reads the clock itself cannot be tested
 *            at 21:01 on a Saturday.
 */
export function quietHoursDecision(cls: NotificationClass, at: Date): QuietDecision {
  if (ALWAYS_SEND.has(cls)) {
    return {
      send: true,
      reason: null,
      sendAfter: null,
      explanation: `${cls} messages are exempt from quiet hours — the recipient is waiting for this one.`,
    };
  }

  const weekend = isWeekendIST(at);
  const night = isNightIST(at);

  if (!weekend && !night) {
    return { send: true, reason: null, sendAfter: null, explanation: "Inside working hours (IST)." };
  }

  const sendAfter = nextOpenWindow(at);
  // Weekend is reported in preference to night: it is the longer hold and the
  // more surprising one to a reader wondering where their email went.
  const reason: QuietReason = weekend ? "weekend" : "night";
  return {
    send: false,
    reason,
    sendAfter,
    explanation: reason === "weekend"
      ? `Held for the weekend — queued for ${sendAfter.toISOString()} (Monday 09:00 IST).`
      : `Held for quiet hours (${QUIET_START_HOUR}:00–0${QUIET_END_HOUR}:00 IST) — queued for ${sendAfter.toISOString()}.`,
  };
}
