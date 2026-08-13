import { describe, it, expect } from "vitest";
import {
  tallyKudos, kudosBudgetLeft, badgesFor, BADGES,
  KUDOS_POINTS, KUDOS_PER_GIVER_PER_PERIOD,
  type KudosRow,
} from "./gamification";

/**
 * Kudos points feed a score, and the score splits a cash bonus pool. So every
 * test here is either the agreed arithmetic or an attempt to manufacture points.
 */

const k = (to: string, from: string, day: number): KudosRow => ({
  userId: to, awardedBy: from, createdAt: `2026-08-${String(day).padStart(2, "0")}T09:00:00Z`,
});

describe("kudos — the currency two colleagues could print", () => {
  it("awards the agreed points for a genuine peer kudos", () => {
    const t = tallyKudos([k("u2", "u1", 1)]);
    expect(t.byUser.u2.points).toBe(KUDOS_POINTS);
    expect(t.byUser.u2.received).toBe(1);
    expect(t.byUser.u2.distinctGivers).toBe(1);
  });

  it("caps each GIVER at the period budget", () => {
    // u1 tries to hand u2 twenty.
    const rows = Array.from({ length: 20 }, (_, i) => k("u2", "u1", (i % 28) + 1));
    const t = tallyKudos(rows);
    expect(t.byUser.u2.points).toBe(KUDOS_PER_GIVER_PER_PERIOD * KUDOS_POINTS);
    expect(t.rejectedOverBudget).toBe(20 - KUDOS_PER_GIVER_PER_PERIOD);
  });

  it("budgets per giver, so two givers are two budgets", () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => k("u3", "u1", i + 1)),
      ...Array.from({ length: 10 }, (_, i) => k("u3", "u2", i + 1)),
    ];
    const t = tallyKudos(rows);
    expect(t.byUser.u3.points).toBe(200);
    expect(t.rejectedOverBudget).toBe(0);
    expect(t.byUser.u3.distinctGivers).toBe(2);
  });

  it("refuses self-kudos", () => {
    const t = tallyKudos([k("u1", "u1", 1)]);
    expect(t.byUser.u1).toBeUndefined();
    expect(t.rejectedSelf).toBe(1);
  });

  it("refuses a kudos with no giver recorded", () => {
    const t = tallyKudos([{ userId: "u1", awardedBy: "", createdAt: "2026-08-01T00:00:00Z" }]);
    expect(t.byUser.u1).toBeUndefined();
    expect(t.rejectedSelf).toBe(1);
  });

  it("gives the same standings whatever order the rows arrive in", () => {
    // The budget cuts off at ten, so which ten count must not depend on however
    // PostgREST happened to sort the result.
    const rows = Array.from({ length: 15 }, (_, i) => k("u2", "u1", i + 1));
    const a = tallyKudos(rows);
    const b = tallyKudos([...rows].reverse());
    expect(a.byUser.u2.points).toBe(b.byUser.u2.points);
    expect(a.rejectedOverBudget).toBe(b.rejectedOverBudget);
  });

  it("survives an unparseable timestamp without dropping the row", () => {
    const t = tallyKudos([{ userId: "u2", awardedBy: "u1", createdAt: "not-a-date" }]);
    expect(t.byUser.u2.points).toBe(KUDOS_POINTS);
  });

  it("returns an empty tally for no kudos", () => {
    const t = tallyKudos([]);
    expect(t.byUser).toEqual({});
    expect(t.rejectedOverBudget).toBe(0);
    expect(t.rejectedSelf).toBe(0);
  });
});

describe("kudosBudgetLeft — what the giver sees before clicking", () => {
  it("starts at the full budget", () => {
    expect(kudosBudgetLeft([], "u1")).toBe(KUDOS_PER_GIVER_PER_PERIOD);
  });

  it("counts down as they award", () => {
    const rows = Array.from({ length: 4 }, (_, i) => k("u2", "u1", i + 1));
    expect(kudosBudgetLeft(rows, "u1")).toBe(KUDOS_PER_GIVER_PER_PERIOD - 4);
  });

  it("never goes below zero", () => {
    const rows = Array.from({ length: 50 }, (_, i) => k("u2", "u1", (i % 28) + 1));
    expect(kudosBudgetLeft(rows, "u1")).toBe(0);
  });

  it("does not count another person's kudos against you", () => {
    const rows = Array.from({ length: 10 }, (_, i) => k("u3", "u2", i + 1));
    expect(kudosBudgetLeft(rows, "u1")).toBe(KUDOS_PER_GIVER_PER_PERIOD);
  });

  it("does not let a self-kudos consume budget", () => {
    expect(kudosBudgetLeft([k("u1", "u1", 1)], "u1")).toBe(KUDOS_PER_GIVER_PER_PERIOD);
  });
});

describe("badges", () => {
  const base = { score: 0, tasksOnTime: 0, renewalPayments: 0, kudosReceived: 0, distinctKudosGivers: 0 };
  const ids = (i: Partial<typeof base>) => badgesFor({ ...base, ...i }).map((b) => b.id);

  it("Master Closer at 1,000 points, not at 999", () => {
    expect(ids({ score: 999  })).not.toContain("master_closer");
    expect(ids({ score: 1000 })).toContain("master_closer");
  });

  it("Lightning Responder needs 10 on-time tasks", () => {
    expect(ids({ tasksOnTime: 9  })).not.toContain("lightning");
    expect(ids({ tasksOnTime: 10 })).toContain("lightning");
  });

  it("Renewal Guardian needs 5 collected renewals", () => {
    expect(ids({ renewalPayments: 4 })).not.toContain("renewal_guardian");
    expect(ids({ renewalPayments: 5 })).toContain("renewal_guardian");
  });

  it("Ultimate Teammate needs kudos from 3+ DIFFERENT people", () => {
    // One friend clicking five times must not earn a teamwork badge.
    expect(ids({ kudosReceived: 5, distinctKudosGivers: 1 })).not.toContain("ultimate_teammate");
    expect(ids({ kudosReceived: 5, distinctKudosGivers: 2 })).not.toContain("ultimate_teammate");
    expect(ids({ kudosReceived: 5, distinctKudosGivers: 3 })).toContain("ultimate_teammate");
  });

  it("awards nothing to a blank scorecard", () => {
    expect(badgesFor(base)).toEqual([]);
  });

  it("can award several at once", () => {
    expect(ids({ score: 1500, tasksOnTime: 12, renewalPayments: 6, kudosReceived: 8, distinctKudosGivers: 4 }))
      .toEqual(["master_closer", "lightning", "renewal_guardian", "ultimate_teammate"]);
  });

  it("returns definitions the UI can render, not bare ids", () => {
    const [b] = badgesFor({ ...base, score: 1000 });
    expect(b.label).toBe("Master Closer");
    expect(b.criterion).toMatch(/1,000/);
    expect(b.emoji).toBeTruthy();
  });

  it("keeps every badge id unique", () => {
    expect(new Set(BADGES.map((b) => b.id)).size).toBe(BADGES.length);
  });
});
