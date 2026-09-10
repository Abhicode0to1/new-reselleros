import { describe, it, expect } from "vitest";
import {
  decideRegistrationRetry,
  unresolvedLiability,
  isResolution,
  MAX_REGISTRATION_ATTEMPTS,
  RETRY_BACKOFF_HOURS,
  RESOLUTIONS,
} from "./retry";

/**
 * The row this governs is a domain the customer HAS PAID FOR AND DOES NOT HAVE.
 * Two mistakes are possible and they are not symmetrical:
 *
 *   · never retrying — the wallet gets topped up and nothing notices, so the
 *     customer stays un-served until somebody happens to look;
 *   · retrying forever — a registration that fails for a real reason (the name
 *     was taken in the meantime) never stops looking busy, so nobody ever
 *     decides on a refund.
 *
 * The budget exists for the second one, which is why every test about running out
 * of it checks that the reason names the DECISION a person now has to make.
 */

const NOW = new Date("2026-09-10T12:00:00Z");
const ago = (mins: number) => new Date(NOW.getTime() - mins * 60_000).toISOString();

describe("only a failed, unresolved registration is retried", () => {
  it("ignores a row that is not failed", () => {
    for (const status of ["active", "pending", "cancelled", "grace", ""]) {
      const d = decideRegistrationRetry({ status, attemptCount: 1, lastAttemptAt: ago(600) }, NOW);
      expect(d.kind, status).toBe("not_applicable");
    }
  });

  it("NEVER retries one a person has already resolved", () => {
    /* The dangerous case: if it was refunded and we then register it, we own a
       domain nobody paid for and the customer has their money back. */
    const d = decideRegistrationRetry(
      { status: "failed", attemptCount: 1, lastAttemptAt: ago(600), resolvedAt: ago(60) },
      NOW,
    );
    expect(d.kind).toBe("not_applicable");
    expect(d.kind === "not_applicable" && d.reason).toMatch(/resolved/);
  });

  it("retries a failed row whose resolution fields are empty", () => {
    for (const resolvedAt of [null, undefined, ""]) {
      const d = decideRegistrationRetry(
        { status: "failed", attemptCount: 1, lastAttemptAt: ago(600), resolvedAt },
        NOW,
      );
      expect(d.kind, String(resolvedAt)).toBe("retry");
    }
  });
});

describe("the backoff — waiting for a human to top up a wallet", () => {
  it("waits an hour after the first attempt", () => {
    const soon = decideRegistrationRetry({ status: "failed", attemptCount: 1, lastAttemptAt: ago(30) }, NOW);
    expect(soon.kind).toBe("wait");
    expect(soon.kind === "wait" && soon.until.toISOString()).toBe("2026-09-10T12:30:00.000Z");

    const later = decideRegistrationRetry({ status: "failed", attemptCount: 1, lastAttemptAt: ago(61) }, NOW);
    expect(later.kind).toBe("retry");
  });

  it("lengthens the wait as attempts accumulate", () => {
    /* 1h, 4h, 12h, 24h — "later today, this evening, tomorrow morning, this
       time tomorrow". A wallet topped up in a working day is picked up that day. */
    expect(RETRY_BACKOFF_HOURS).toEqual([1, 4, 12, 24]);
    const waitAfter = (attempts: number) => {
      const d = decideRegistrationRetry(
        { status: "failed", attemptCount: attempts, lastAttemptAt: ago(1) },
        NOW,
      );
      return d.kind === "wait" ? Math.round((d.until.getTime() - NOW.getTime()) / 3_600_000) : null;
    };
    expect(waitAfter(1)).toBe(1);
    expect(waitAfter(2)).toBe(4);
    expect(waitAfter(3)).toBe(12);
    expect(waitAfter(4)).toBe(24);
  });

  it("retries immediately when the row was marked failed without a timestamp", () => {
    /* Otherwise the row waits on a date that is never going to arrive. The
       budget still bounds it, so this cannot loop. */
    const d = decideRegistrationRetry({ status: "failed", attemptCount: 2, lastAttemptAt: null }, NOW);
    expect(d.kind).toBe("retry");
  });

  it("says how long it has been, so a log line is readable", () => {
    const d = decideRegistrationRetry({ status: "failed", attemptCount: 1, lastAttemptAt: ago(15) }, NOW);
    expect(d.kind === "wait" && d.reason).toMatch(/15 minutes ago/);
  });

  it("survives an unparseable timestamp rather than throwing on it", () => {
    const d = decideRegistrationRetry({ status: "failed", attemptCount: 1, lastAttemptAt: "not a date" }, NOW);
    expect(d.kind).toBe("retry");
  });
});

describe("running out of budget hands over to a person", () => {
  it("stops after the fifth attempt", () => {
    expect(MAX_REGISTRATION_ATTEMPTS).toBe(5);
    const d = decideRegistrationRetry(
      { status: "failed", attemptCount: 5, lastAttemptAt: ago(10_000) },
      NOW,
    );
    expect(d.kind).toBe("give_up");
  });

  it("names the DECISION rather than just reporting failure", () => {
    /* The point of stopping is that somebody now chooses. A reason that only
       says "gave up" leaves the reader with nothing to do. */
    const d = decideRegistrationRetry({ status: "failed", attemptCount: 9, lastAttemptAt: ago(10_000) }, NOW);
    expect(d.kind === "give_up" && d.reason).toMatch(/refund/);
    expect(d.kind === "give_up" && d.reason).toMatch(/5 attempts|9 attempts/);
  });

  it("gives up regardless of how long ago the last attempt was", () => {
    /* An exhausted budget is not a timing question. */
    const d = decideRegistrationRetry({ status: "failed", attemptCount: 5, lastAttemptAt: ago(1) }, NOW);
    expect(d.kind).toBe("give_up");
  });

  it("treats a nonsense attempt count as zero rather than crashing", () => {
    for (const n of [NaN, -3, undefined as unknown as number]) {
      const d = decideRegistrationRetry({ status: "failed", attemptCount: n, lastAttemptAt: null }, NOW);
      expect(d.kind, String(n)).toBe("retry");
    }
  });
});

describe("unresolvedLiability — what is owed", () => {
  it("adds up what customers have paid for names they do not have", () => {
    expect(unresolvedLiability([{ amount_paid: 1200 }, { amount_paid: 899 }])).toBe(2099);
  });

  it("counts a missing amount as nothing, without dropping the row's existence", () => {
    /* A failure with no recorded amount is a gap in the record. It contributes
       nothing to the total but must still appear in the queue — which is why the
       index predicate deliberately does not filter on amount_paid > 0. */
    expect(unresolvedLiability([{ amount_paid: 1200 }, { amount_paid: null }])).toBe(1200);
  });

  it("is zero for an empty queue", () => {
    expect(unresolvedLiability([])).toBe(0);
  });
});

describe("resolutions", () => {
  it("accepts the four ways this gets closed and nothing else", () => {
    for (const r of RESOLUTIONS) expect(isResolution(r)).toBe(true);
    for (const bad of ["done", "", null, undefined, "REFUNDED"]) {
      expect(isResolution(bad), String(bad)).toBe(false);
    }
  });

  it("keeps a refund and a re-registration as different events", () => {
    /* Both make the customer whole; they are not the same thing and the money
       moves in opposite directions. */
    expect(RESOLUTIONS).toContain("refunded");
    expect(RESOLUTIONS).toContain("re_registered");
  });
});
