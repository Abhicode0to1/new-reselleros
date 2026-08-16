import { describe, it, expect } from "vitest";
import {
  assessUtilisation, utilisationTotals, utilisationBadge, LOW_UTILISATION_PCT,
} from "./utilisation";

describe("`used = 0` with no sync is UNKNOWN, not 0%", () => {
  it("does not flag a never-synced subscription as a churn risk", () => {
    /* Every insert path in this app writes used: 0 and nothing updates it. Taking
       that at face value flags 100% of subscriptions, and a red badge on everything
       is a badge nobody sees. */
    const r = assessUtilisation({ seats: 10, used: 0 });
    expect(r.level).toBe("unknown");
    expect(r.churnRisk).toBe(false);
    expect(r.pct).toBeNull();
    expect(r.message).toMatch(/never been synced/);
  });

  it("treats null the same way", () => {
    expect(assessUtilisation({ seats: 10, used: null }).level).toBe("unknown");
  });

  it("BUT a synced zero is real, and is the worst case", () => {
    const r = assessUtilisation({ seats: 10, used: 0, usedSyncedAt: "2026-08-16T00:00:00Z" });
    expect(r.level).toBe("idle");
    expect(r.churnRisk).toBe(true);
    expect(r.message).toMatch(/nobody is on them/);
  });
});

describe("the threshold", () => {
  it.each([
    [10, 5,  "low"],      // 50%
    [10, 6,  "healthy"],  // 60% — at the line, not below it
    [10, 7,  "healthy"],
    [10, 10, "healthy"],
    [100, 59, "low"],
  ])("%s seats, %s used → %s", (seats, used, level) => {
    expect(assessUtilisation({ seats, used, usedSyncedAt: "2026-08-16T00:00:00Z" }).level).toBe(level);
  });

  it("uses the documented constant", () => {
    expect(LOW_UTILISATION_PCT).toBe(60);
  });

  it("reports idle seats and the percentage on a low row", () => {
    const r = assessUtilisation({ seats: 20, used: 8, usedSyncedAt: "2026-08-16T00:00:00Z" });
    expect(r).toMatchObject({ pct: 40, idleSeats: 12, churnRisk: true });
    expect(r.message).toMatch(/Only 8 of 20 seats/);
  });

  it("names the action, not just the problem", () => {
    const r = assessUtilisation({ seats: 20, used: 8, usedSyncedAt: "2026-08-16T00:00:00Z" });
    expect(r.message).toMatch(/talk to them before they ask/);
  });
});

describe("edge cases", () => {
  it("a zero-seat subscription is unknown, not a division by zero", () => {
    const r = assessUtilisation({ seats: 0, used: 0, usedSyncedAt: "2026-08-16T00:00:00Z" });
    expect(r.level).toBe("unknown");
    expect(Number.isFinite(r.pct ?? 0)).toBe(true);
  });

  it("more assigned than billed does not go over 100% risk", () => {
    const r = assessUtilisation({ seats: 10, used: 14, usedSyncedAt: "2026-08-16T00:00:00Z" });
    expect(r.level).toBe("healthy");
    expect(r.idleSeats).toBe(0);
  });

  it("truncates fractional input", () => {
    expect(assessUtilisation({ seats: 10.7, used: 5.9, usedSyncedAt: "x" }).pct).toBe(50);
  });
});

describe("utilisationTotals — unknowns are counted, never assumed healthy", () => {
  const synced = "2026-08-16T00:00:00Z";
  const rows = [
    assessUtilisation({ seats: 10, used: 0 }),                        // unknown
    assessUtilisation({ seats: 10, used: 0, usedSyncedAt: synced }),  // idle
    assessUtilisation({ seats: 10, used: 4, usedSyncedAt: synced }),  // low
    assessUtilisation({ seats: 10, used: 9, usedSyncedAt: synced }),  // healthy
  ];

  it("separates at-risk from unmeasured", () => {
    /* "0 at risk" over a fleet nobody can see would be the most misleading thing on
       the page. */
    const t = utilisationTotals(rows);
    expect(t).toMatchObject({ atRiskCount: 2, idleCount: 1, unknownCount: 1, knownCount: 3 });
  });

  it("counts idle seats only where they are known", () => {
    expect(utilisationTotals(rows).idleSeats).toBe(10 + 6 + 1);
  });

  it("is all zeroes on an empty list", () => {
    expect(utilisationTotals([])).toEqual({
      atRiskCount: 0, idleCount: 0, unknownCount: 0, knownCount: 0, idleSeats: 0,
    });
  });
});

describe("utilisationBadge", () => {
  it("says 'not tracked' rather than showing a percentage nobody measured", () => {
    expect(utilisationBadge(assessUtilisation({ seats: 10, used: 0 })))
      .toEqual({ label: "Usage not tracked", kind: "muted" });
  });

  it("covers every level", () => {
    const synced = "2026-08-16T00:00:00Z";
    expect(utilisationBadge(assessUtilisation({ seats: 10, used: 0, usedSyncedAt: synced })).kind).toBe("danger");
    expect(utilisationBadge(assessUtilisation({ seats: 10, used: 4, usedSyncedAt: synced })).kind).toBe("warning");
    expect(utilisationBadge(assessUtilisation({ seats: 10, used: 9, usedSyncedAt: synced })).kind).toBe("success");
  });
});
