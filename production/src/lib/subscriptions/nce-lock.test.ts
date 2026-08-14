import { describe, it, expect } from "vitest";
import { checkNceLock, lockWarning, NCE_WINDOW_DAYS } from "./nce-lock";

/** Term started 1 Aug 2026. Day 7 is 8 Aug; day 8 (15 Aug) is outside. */
const START = "2026-08-01";
const base = {
  vendor: "microsoft",
  startDate: START,
  currentSeats: 10,
  nextSeats: 10,
  nextStatus: "active" as string | null,
  today: START,
};

describe("checkNceLock — only Microsoft, only reductions", () => {
  it("never locks Google, Zoho or anything else", () => {
    for (const vendor of ["google", "zoho", "other", "domain", null, undefined]) {
      const r = checkNceLock({ ...base, vendor, today: "2027-01-01", nextSeats: 1, nextStatus: "cancelled" });
      expect(r.locked).toBe(false);
      expect(r.action).toBeNull();
    }
  });

  it("never blocks ADDING seats, however old the term", () => {
    // NCE restricts reductions only. Expansion is always allowed.
    const r = checkNceLock({ ...base, today: "2030-01-01", nextSeats: 500 });
    expect(r.locked).toBe(false);
    expect(r.action).toBeNull();
  });

  it("never blocks an unchanged seat count", () => {
    expect(checkNceLock({ ...base, today: "2030-01-01", nextSeats: 10 }).locked).toBe(false);
  });

  it("never blocks pausing — only 'cancelled' is a cancellation", () => {
    const r = checkNceLock({ ...base, today: "2030-01-01", nextStatus: "paused" });
    expect(r.locked).toBe(false);
  });
});

describe("checkNceLock — inside the 168-hour window", () => {
  it.each([
    ["2026-08-01", 7],   // day 0
    ["2026-08-04", 4],
    ["2026-08-07", 1],   // day 6 — the last permitted day
  ])("allows a reduction on %s", (today) => {
    const r = checkNceLock({ ...base, today, nextSeats: 5 });
    expect(r.locked).toBe(false);
    expect(r.action).toBe("reduce_seats");
  });

  it("the boundary leans towards BLOCKING — day 6 allowed, day 7 locked", () => {
    /* This test originally asserted the opposite and called it "the risky side
       deliberately chosen". The risk was backwards: allowing a reduction Microsoft
       refuses is SILENT (our 5 seats against their 10, found on the distributor
       invoice), whereas blocking one Microsoft would have taken is recoverable with
       a phone call. Blocking a day early is the cheap mistake. */
    expect(checkNceLock({ ...base, today: "2026-08-07", nextSeats: 5 }).locked).toBe(false);
    expect(checkNceLock({ ...base, today: "2026-08-08", nextSeats: 5 }).locked).toBe(true);
  });

  it("a term that has not started yet is not locked", () => {
    const r = checkNceLock({ ...base, today: "2026-07-25", nextSeats: 5 });
    expect(r.locked).toBe(false);
    expect(r.dayssince).toBe(-7);
    expect(r.daysLeft).toBe(NCE_WINDOW_DAYS);
  });
});

describe("checkNceLock — after the window has closed", () => {
  const late = { ...base, today: "2026-09-15" };   // day 45

  it("locks a seat reduction and says how long ago the window closed", () => {
    const r = checkNceLock({ ...late, nextSeats: 5 });
    expect(r.locked).toBe(true);
    expect(r.action).toBe("reduce_seats");
    expect(r.dayssince).toBe(45);
    expect(r.daysLeft).toBe(0);
    expect(r.reason).toContain("45 days ago");
    expect(r.reason).toContain("10 to 5");
  });

  it("locks a cancellation", () => {
    const r = checkNceLock({ ...late, nextStatus: "cancelled" });
    expect(r.locked).toBe(true);
    expect(r.action).toBe("cancel");
  });

  it("reports 'both' when seats are cut AND the status is cancelled", () => {
    const r = checkNceLock({ ...late, nextSeats: 0, nextStatus: "cancelled" });
    expect(r.action).toBe("both");
    expect(r.locked).toBe(true);
  });

  it("the refusal states WHY and gives a way forward (§24)", () => {
    const r = checkNceLock({ ...late, nextSeats: 5 });
    // Why Microsoft's rule matters to us: our number would stop matching the bill.
    expect(r.reason).toMatch(/full committed term/i);
    expect(r.reason).toMatch(/distributor invoice/i);
    // The two things they CAN actually do.
    expect(r.reason).toMatch(/auto-renew/i);
    expect(r.reason).toMatch(/NEXT term/i);
  });
});

describe("checkNceLock — what it refuses to judge", () => {
  it("does NOT lock when start_date is missing", () => {
    // Refusing an edit over data we never captured traps the operator with no way
    // out. lockWarning() surfaces it instead.
    const r = checkNceLock({ ...base, startDate: null, today: "2030-01-01", nextSeats: 1 });
    expect(r.locked).toBe(false);
    expect(r.action).toBe("reduce_seats");   // still names the action
  });

  it("does NOT lock on an unparseable start_date, and does not throw", () => {
    const r = checkNceLock({ ...base, startDate: "not-a-date", today: "2030-01-01", nextSeats: 1 });
    expect(r.locked).toBe(false);
  });
});

describe("lockWarning — the heads-up before the wall", () => {
  it("warns on the last three days", () => {
    // Regression: an earlier lockWarning borrowed checkNceLock's arithmetic by
    // passing an unchanged seat count, which is not a governed action — so it
    // short-circuited and returned null EVERY day. It looked implemented and
    // warned nobody once.
    for (const [today, left] of [["2026-08-05", 3], ["2026-08-06", 2], ["2026-08-07", 1]] as const) {
      const w = lockWarning({ ...base, today });
      expect(w, `expected a warning on ${today}`).not.toBeNull();
      expect(w).toContain(`${left} day`);
      expect(w).toMatch(/cancel or reduce/i);
    }
  });

  it("stays quiet early in the window — a warning every day is noise", () => {
    expect(lockWarning({ ...base, today: "2026-08-01" })).toBeNull();
    expect(lockWarning({ ...base, today: "2026-08-03" })).toBeNull();
  });

  it("stays quiet once the window has closed — that is the block's job", () => {
    expect(lockWarning({ ...base, today: "2026-09-15" })).toBeNull();
  });

  it("flags a missing start date, because Microsoft enforces it regardless", () => {
    const w = lockWarning({ ...base, startDate: null });
    expect(w).toMatch(/no start date/i);
    expect(w).toMatch(/Add the start date/i);
  });

  it("says nothing for a non-Microsoft subscription", () => {
    expect(lockWarning({ ...base, vendor: "google", today: "2026-08-07" })).toBeNull();
  });
});
