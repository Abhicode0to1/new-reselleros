import { describe, it, expect } from "vitest";
import {
  SUSPEND_BACKOFF_MINUTES,
  suspendRetryDelayMinutes,
  nextSuspendAttemptAt,
} from "./suspend-backoff";

describe("suspendRetryDelayMinutes — soon, then sensible, then never gives up", () => {
  it("the first failure is retried soon, because it is probably a blip", () => {
    expect(suspendRetryDelayMinutes(1)).toBe(15);
  });

  it("walks the table in order", () => {
    expect([1, 2, 3, 4].map(suspendRetryDelayMinutes)).toEqual([15, 60, 240, 1440]);
  });

  /* No attempt limit and no dead state: a suspension that never lands means a
     refunded customer's website is still serving, so something must keep
     trying. This is the assertion that says so. */
  it("keeps retrying daily forever, rather than giving up", () => {
    for (const n of [5, 6, 20, 500, 100_000]) {
      expect(suspendRetryDelayMinutes(n), `attempt ${n}`).toBe(1440);
    }
  });

  /* ─── The out-of-range values, and why they matter ────────────────────────
     Not defensive box-ticking. `undefined` out of the table would become NaN
     milliseconds, `new Date(NaN).toISOString()` THROWS, and the row would keep
     its old due date — so the item would come back on the very next run, and
     every run after that, in a tight loop against a server already refusing
     us. The shortest wait is the answer that cannot do harm. */
  it("never returns undefined for a count outside the table", () => {
    for (const n of [0, -1, -999, 0.5, 1.9]) {
      const d = suspendRetryDelayMinutes(n);
      expect(d, `attempt ${n}`).toBeTypeOf("number");
      expect(Number.isFinite(d), `attempt ${n} gave ${d}`).toBe(true);
      expect(SUSPEND_BACKOFF_MINUTES).toContain(d);
    }
  });

  it("the interval never decreases as attempts grow", () => {
    let prev = 0;
    for (let n = 1; n <= 10; n++) {
      const d = suspendRetryDelayMinutes(n);
      expect(d, `attempt ${n} waits less than attempt ${n - 1}`).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });
});

describe("nextSuspendAttemptAt — a timestamp Postgres will accept", () => {
  const NOW = new Date("2026-09-11T10:00:00.000Z");

  it("adds the delay to now", () => {
    expect(nextSuspendAttemptAt(1, NOW)).toBe("2026-09-11T10:15:00.000Z");
    expect(nextSuspendAttemptAt(2, NOW)).toBe("2026-09-11T11:00:00.000Z");
    expect(nextSuspendAttemptAt(3, NOW)).toBe("2026-09-11T14:00:00.000Z");
    expect(nextSuspendAttemptAt(4, NOW)).toBe("2026-09-12T10:00:00.000Z");
  });

  it("is always strictly in the future — a due date in the past is a loop", () => {
    for (const n of [0, 1, 2, 5, 50]) {
      expect(new Date(nextSuspendAttemptAt(n, NOW)).getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it("never produces an invalid date", () => {
    for (const n of [0, -5, 1, 99, 1.5]) {
      expect(nextSuspendAttemptAt(n, NOW)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });
});
