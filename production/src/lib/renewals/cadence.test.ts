import { describe, it, expect } from "vitest";
import { decideCadence, type RenewalState } from "./cadence";

// Fixed "today" = 1 Aug 2026, 11:30 IST. Renewal dates below are date-only, so
// daysBetween (IST-snapped) yields the exact daysOut noted in each case.
const TODAY = new Date("2026-08-01T06:00:00Z");

function decide(renewalDate: string, currentState: RenewalState, graceDays = 5) {
  return decideCadence({ renewalDate, graceDays, currentState, today: TODAY });
}

describe("decideCadence — normal cadence", () => {
  it("T-15, pending → sends the notice", () => {
    const d = decide("2026-08-16", "pending"); // daysOut 15
    expect(d.targetState).toBe("notice_sent");
    expect(d.shouldSendEmail).toBe(true);
  });

  it("T-0 (renewal today), reminder_4 → sends the final notice", () => {
    const d = decide("2026-08-01", "reminder_4"); // daysOut 0
    expect(d.targetState).toBe("final_sent");
    expect(d.shouldSendEmail).toBe(true);
  });

  it("far out (d ≥ 31) → pending, no email", () => {
    // Was "d ≥ 16" with a 19-day case. Migration 0228 opened the cadence at
    // T-30, so 19 days out now legitimately fires the early notice — the old
    // assertion was describing the old ladder, not a broken one.
    const d = decide("2026-09-20", "pending"); // daysOut 50
    expect(d.targetState).toBe("pending");
    expect(d.shouldSendEmail).toBe(false);
  });
});

describe("decideCadence — T-30 early notice (migration 0228)", () => {
  it("T-30 exactly → early_notice, one email", () => {
    const d = decide("2026-08-31", "pending"); // daysOut 30
    expect(d.targetState).toBe("early_notice");
    expect(d.tone).toBe("early");
    expect(d.shouldSendEmail).toBe(true);
  });

  it("T-31 is still too early", () => {
    const d = decide("2026-09-01", "pending"); // daysOut 31
    expect(d.targetState).toBe("pending");
    expect(d.shouldSendEmail).toBe(false);
  });

  it("catch-up: a cron that missed T-30 still sends it at T-22", () => {
    // Same catch-up rule the rest of the ladder uses — an outage or a deploy
    // must not silently swallow a step.
    const d = decide("2026-08-23", "pending"); // daysOut 22
    expect(d.targetState).toBe("early_notice");
    expect(d.shouldSendEmail).toBe(true);
  });

  it("does not resend the early notice once it has been sent", () => {
    const d = decide("2026-08-25", "early_notice"); // daysOut 24
    expect(d.targetState).toBe("early_notice");
    expect(d.shouldSendEmail).toBe(false);
  });

  it("T-15 still fires after the early notice — the ladder advances", () => {
    // The reason early_notice needed its OWN enum value: folding T-30 into
    // 'notice_sent' would make this look already-sent and skip the real notice.
    const d = decide("2026-08-16", "early_notice"); // daysOut 15
    expect(d.targetState).toBe("notice_sent");
    expect(d.shouldSendEmail).toBe(true);
  });

  it("a subscription already renewed never gets an early notice", () => {
    const d = decide("2026-08-31", "renewed");
    expect(d.shouldSendEmail).toBe(false);
  });

  it("T-30 does not suspend anything", () => {
    expect(decide("2026-08-31", "pending").shouldSuspend).toBe(false);
  });
});

describe("decideCadence — catch-up (audit bug #21)", () => {
  it("RN-04: T-15 cron missed, runs at T-12 with state still pending → fires the current-urgency reminder, not the stale notice", () => {
    const d = decide("2026-08-13", "pending"); // daysOut 12
    expect(d.targetState).toBe("reminder_1");
    expect(d.shouldSendEmail).toBe(true);
  });

  it("RN-05: renewal_date nudged to a non-trigger day (T-2), only the notice was ever sent → still fires the urgent reminder (old exact-match code skipped this)", () => {
    const d = decide("2026-08-03", "notice_sent"); // daysOut 2 (between T-3 and T-0)
    expect(d.targetState).toBe("reminder_4");
    expect(d.shouldSendEmail).toBe(true);
  });

  it("missed T-6: at T-5 with state reminder_2 → catches up to reminder_3", () => {
    const d = decide("2026-08-06", "reminder_2"); // daysOut 5 (between T-6 and T-3)
    expect(d.targetState).toBe("reminder_3");
    expect(d.shouldSendEmail).toBe(true);
  });
});

describe("decideCadence — idempotency & no-op", () => {
  it("already at the reached step → no resend", () => {
    const d = decide("2026-08-04", "reminder_4"); // daysOut 3 == T-3, already reminder_4
    expect(d.targetState).toBe("reminder_4");
    expect(d.shouldSendEmail).toBe(false);
  });

  it("between triggers, already at the reached step → no email, state stable", () => {
    const d = decide("2026-08-08", "reminder_2"); // daysOut 7 (between T-9 and T-6)
    expect(d.targetState).toBe("reminder_2");
    expect(d.shouldSendEmail).toBe(false);
  });

  it("terminal state 'renewed' near a trigger day → never re-enters cadence", () => {
    const d = decide("2026-08-03", "renewed"); // daysOut 2
    expect(d.shouldSendEmail).toBe(false);
  });
});

describe("decideCadence — past renewal (grace / suspend)", () => {
  it("within grace → grace reminder once", () => {
    const d = decide("2026-07-30", "final_sent", 5); // daysOut -2, grace 5
    expect(d.targetState).toBe("grace_period");
    expect(d.shouldSendEmail).toBe(true);
    expect(d.shouldSuspend).toBe(false);
  });

  it("past grace → suspend, no email", () => {
    const d = decide("2026-07-20", "grace_period", 5); // daysOut -12, grace 5
    expect(d.targetState).toBe("suspended");
    expect(d.shouldSuspend).toBe(true);
    expect(d.shouldSendEmail).toBe(false);
  });
});
