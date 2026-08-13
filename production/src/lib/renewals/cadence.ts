/**
 * Renewal cadence — pure functions, no I/O.
 *
 * Given a subscription's renewal_date + the tenant's grace_period_days,
 * compute what step the sub should be in TODAY and whether to send an
 * email. Idempotent — re-running on the same day is a no-op (the cron
 * checks renewal_email_log before sending).
 *
 * Cadence (in "days until renewal" form):
 *   d ≥ 31        → 'pending'        no email
 *   d == 30       → 'early_notice'   early heads-up (migration 0228)
 *   d == 15       → 'notice_sent'    soft notice + PDF quote attached
 *   d == 12       → 'reminder_1'     soft reminder
 *   d == 9        → 'reminder_2'     friendly
 *   d == 6        → 'reminder_3'     firm
 *   d == 3        → 'reminder_4'     urgent — service interruption ahead
 *   d == 0        → 'final_sent'     final notice + suspension warning
 *   d ∈ (−grace,−1] → 'grace_period' grace reminder (only if grace > 0)
 *   d < −grace    → 'suspended'      auto-suspend, no email
 */

export type RenewalState =
  | "pending"
  /** T-30 early heads-up. Requires migration 0228 to exist in the DB enum. */
  | "early_notice"
  | "notice_sent"
  | "reminder_1"
  | "reminder_2"
  | "reminder_3"
  | "reminder_4"
  | "final_sent"
  | "grace_period"
  | "renewed"
  | "suspended";

export type CadenceTone = "early" | "soft" | "friendly" | "firm" | "urgent" | "final" | "grace";

/**
 * Trigger map — which day before renewal triggers which step.
 *
 * MUST STAY IN DESCENDING daysOut ORDER. decideCadence() walks this list to find
 * the most-urgent trigger that should already have fired (the catch-up rule for a
 * cron that missed a day), and that scan assumes the ordering.
 *
 * T-30 was added last (migration 0228) and is a heads-up, not a chase: an annual
 * Workspace renewal often needs a PO raised or a budget signed off, and a
 * fortnight is not enough room for that during a quarter close.
 */
export const CADENCE_TRIGGERS: { daysOut: number; step: RenewalState; tone: CadenceTone }[] = [
  { daysOut: 30, step: "early_notice", tone: "early"    },
  { daysOut: 15, step: "notice_sent",  tone: "soft"     },
  { daysOut: 12, step: "reminder_1",   tone: "soft"     },
  { daysOut:  9, step: "reminder_2",   tone: "friendly" },
  { daysOut:  6, step: "reminder_3",   tone: "firm"     },
  { daysOut:  3, step: "reminder_4",   tone: "urgent"   },
  { daysOut:  0, step: "final_sent",   tone: "final"    },
];

/** Days between two dates (calendar, IST-aware). Positive when `to` is in the future. */
export function daysBetween(from: Date, to: Date): number {
  // Snap both to IST midnight then diff
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  const fromIST = Math.floor((from.getTime() + istOffsetMs) / dayMs);
  const toIST   = Math.floor((to.getTime()   + istOffsetMs) / dayMs);
  return toIST - fromIST;
}

export interface CadenceDecision {
  /** What state the subscription should be in today. */
  targetState: RenewalState;
  /** Days until renewal (positive = future, 0 = today, negative = past). */
  daysUntilRenewal: number;
  /** True if today triggers a NEW email (not previously sent for this step). */
  shouldSendEmail: boolean;
  /** Suggested tone for the email template. */
  tone: CadenceTone | null;
  /** True if today's cron should auto-suspend this subscription. */
  shouldSuspend: boolean;
}

export interface CadenceInput {
  renewalDate:      Date | string;      // subscription.renewal_date
  graceDays:        number;             // tenant.grace_period_days
  currentState:     RenewalState;       // subscription.renewal_state
  today?:           Date;               // override for testing
}

/**
 * Compute what should happen today for one subscription.
 */
export function decideCadence(input: CadenceInput): CadenceDecision {
  const today = input.today ?? new Date();
  const renewalAt = input.renewalDate instanceof Date
    ? input.renewalDate
    : new Date(input.renewalDate);

  const daysOut = daysBetween(today, renewalAt);

  // Past renewal_date — grace or suspend
  if (daysOut < 0) {
    const daysIntoGrace = Math.abs(daysOut);
    if (daysIntoGrace <= input.graceDays) {
      return {
        targetState:    "grace_period",
        daysUntilRenewal: daysOut,
        shouldSendEmail: input.currentState !== "grace_period" && input.currentState !== "renewed" && input.currentState !== "suspended",
        tone:           "grace",
        shouldSuspend:  false,
      };
    }
    return {
      targetState:    "suspended",
      daysUntilRenewal: daysOut,
      shouldSendEmail: false,        // no email on hard suspend
      tone:           null,
      shouldSuspend:  input.currentState !== "suspended" && input.currentState !== "renewed",
    };
  }

  // Future — CATCH-UP match (audit bug #21): fire the most-urgent cadence
  // trigger that should have fired by today — the trigger with the smallest
  // daysOut still ≥ today's daysOut. So a missed cron day (outage / deploy) or
  // a renewal_date nudged onto a non-trigger day (T-2, T-1) still fires the
  // right reminder instead of being silently skipped until T-0.
  //
  // We never resend a step already reached: cadence state progresses linearly
  // through CADENCE_TRIGGERS, so we only send when the target step is MORE
  // advanced (higher index) than the current state. The cron's
  // renewal_email_log adds a second, independent (sub, step) idempotency guard.
  const reached = CADENCE_TRIGGERS.filter((t) => daysOut <= t.daysOut);
  const trigger = reached.length > 0 ? reached[reached.length - 1] : null;
  if (trigger) {
    const rankOf = (s: RenewalState) => CADENCE_TRIGGERS.findIndex((t) => t.step === s);
    const isTerminal = input.currentState === "renewed" || input.currentState === "suspended";
    return {
      targetState:      trigger.step,
      daysUntilRenewal: daysOut,
      shouldSendEmail:  !isTerminal && rankOf(trigger.step) > rankOf(input.currentState),
      tone:             trigger.tone,
      shouldSuspend:    false,
    };
  }

  // Before the first trigger (d ≥ 31 since 0228 added T-30) — pending, no email
  return {
    targetState:      "pending",
    daysUntilRenewal: daysOut,
    shouldSendEmail:  false,
    tone:             null,
    shouldSuspend:    false,
  };
}

/** Friendly label for a renewal state, for UI badges. */
export function renewalStateLabel(state: RenewalState): string {
  switch (state) {
    case "pending":      return "Pending";
    case "early_notice": return "Early notice (T-30)";
    case "notice_sent":  return "Notice sent (T-15)";
    case "reminder_1":   return "Reminder 1 (T-12)";
    case "reminder_2":   return "Reminder 2 (T-9)";
    case "reminder_3":   return "Reminder 3 (T-6)";
    case "reminder_4":   return "Urgent (T-3)";
    case "final_sent":   return "Final notice";
    case "grace_period": return "Grace period";
    case "renewed":      return "Renewed";
    case "suspended":    return "Suspended";
  }
}

/** Color hint for badge rendering. */
export function renewalStateTone(state: RenewalState): "muted" | "info" | "warning" | "danger" | "success" {
  switch (state) {
    case "pending":
    case "renewed":      return "muted";
    // T-30 is a heads-up, not a chase — it must not look like a warning.
    case "early_notice": return "info";
    case "notice_sent":
    case "reminder_1":   return "info";
    case "reminder_2":
    case "reminder_3":   return "warning";
    case "reminder_4":
    case "final_sent":
    case "grace_period": return "danger";
    case "suspended":    return "danger";
  }
}
