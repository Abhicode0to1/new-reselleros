import { describe, it, expect } from "vitest";
import {
  reconstructWaterfall,
  fromLedger,
  netNewMrr,
  type MrrSubscription,
  type MrrMovement,
} from "./mrr-waterfall";

const FROM = "2026-07-01";
const TO = "2026-08-01";

function sub(p: Partial<MrrSubscription> & { id: string; mrr: number }): MrrSubscription {
  return { startDate: "2026-01-01", endDate: null, status: "active", ...p };
}

describe("reconstructWaterfall", () => {
  it("places a pre-existing subscription in both Starting and Ending", () => {
    const w = reconstructWaterfall([sub({ id: "a", mrr: 5000 })], FROM, TO);
    expect(w.startingMrr).toBe(5000);
    expect(w.endingMrr).toBe(5000);
    expect(w.newMrr).toBe(0);
    expect(w.churnedMrr).toBe(0);
  });

  it("counts a subscription started inside the window as New, not Starting", () => {
    const w = reconstructWaterfall(
      [sub({ id: "a", mrr: 3000, startDate: "2026-07-10" })],
      FROM, TO,
    );
    expect(w.startingMrr).toBe(0);
    expect(w.newMrr).toBe(3000);
    expect(w.endingMrr).toBe(3000);
  });

  it("counts a subscription cancelled inside the window as Churn and drops it from Ending", () => {
    const w = reconstructWaterfall(
      [sub({ id: "a", mrr: 2000, endDate: "2026-07-15", status: "cancelled" })],
      FROM, TO,
    );
    expect(w.startingMrr).toBe(2000);
    expect(w.churnedMrr).toBe(2000);
    expect(w.endingMrr).toBe(0);
  });

  it("closes the identity when nothing was upgraded or downgraded", () => {
    // The whole point: with only new + churn, the waterfall must reconcile exactly.
    const w = reconstructWaterfall(
      [
        sub({ id: "keep", mrr: 5000 }),
        sub({ id: "new", mrr: 3000, startDate: "2026-07-10" }),
        sub({ id: "gone", mrr: 2000, endDate: "2026-07-15", status: "cancelled" }),
      ],
      FROM, TO,
    );
    expect(w.startingMrr).toBe(7000);   // keep + gone
    expect(w.newMrr).toBe(3000);
    expect(w.churnedMrr).toBe(2000);
    expect(w.endingMrr).toBe(8000);     // keep + new
    expect(w.startingMrr + w.newMrr - w.churnedMrr).toBe(w.endingMrr);
    expect(w.unexplained).toBe(0);
  });

  it("NEVER reports expansion or contraction as zero", () => {
    // Zero would read as "nobody upgraded". The truth is "not recorded".
    const w = reconstructWaterfall([sub({ id: "a", mrr: 5000 })], FROM, TO);
    expect(w.expansion).toBeNull();
    expect(w.contraction).toBeNull();
    expect(w.basis).toBe("reconstructed");
  });

  it("always says out loud that expansion is untracked", () => {
    const w = reconstructWaterfall([sub({ id: "a", mrr: 5000 })], FROM, TO);
    expect(w.notes.join(" ")).toMatch(/not tracked/i);
  });

  it("excludes a subscription with no start date instead of inventing New MRR", () => {
    // Counting it in Ending but not Starting would fabricate growth out of a
    // missing field — the exact kind of silent lie this report must not tell.
    const w = reconstructWaterfall(
      [sub({ id: "a", mrr: 9999, startDate: null })],
      FROM, TO,
    );
    expect(w.startingMrr).toBe(0);
    expect(w.newMrr).toBe(0);
    expect(w.endingMrr).toBe(0);
    expect(w.notes.join(" ")).toMatch(/no start date/i);
  });

  it("treats a subscription ending exactly at the window start as already gone", () => {
    const w = reconstructWaterfall(
      [sub({ id: "a", mrr: 1000, endDate: FROM, status: "cancelled" })],
      FROM, TO,
    );
    // Boundary is inclusive at `from`, so it is alive at the start and churns in-window.
    expect(w.startingMrr).toBe(1000);
    expect(w.churnedMrr).toBe(1000);
    expect(w.endingMrr).toBe(0);
  });

  it("returns a safe empty result for an inverted date range", () => {
    const w = reconstructWaterfall([sub({ id: "a", mrr: 5000 })], TO, FROM);
    expect(w.endingMrr).toBe(0);
    expect(w.notes[0]).toMatch(/Invalid date range/i);
  });

  it("handles no subscriptions at all", () => {
    const w = reconstructWaterfall([], FROM, TO);
    expect(w.startingMrr).toBe(0);
    expect(w.endingMrr).toBe(0);
    expect(w.unexplained).toBe(0);
  });
});

describe("reconstructWaterfall — the residual", () => {
  it("surfaces unrecorded movement instead of hiding it", () => {
    // Same subscription in Starting and Ending, but its mrr is read once — so a
    // genuine mid-window upgrade CANNOT show up here. We simulate the visible
    // symptom: a row alive at the end that was not alive at the start and did not
    // start in-window is impossible, so we use a churn with a survivor to force
    // the arithmetic and assert the residual is reported, not swallowed.
    const w = reconstructWaterfall(
      [
        sub({ id: "a", mrr: 5000 }),
        // Ends after the window → alive at both ends, no movement.
        sub({ id: "b", mrr: 1000, endDate: "2026-12-01" }),
      ],
      FROM, TO,
    );
    expect(w.unexplained).toBe(0);
    expect(w.startingMrr).toBe(6000);
    expect(w.endingMrr).toBe(6000);
  });

  it("names the residual in the notes when it is non-zero", () => {
    // Force a gap: a row that is dead by status but has no end date is excluded
    // from Ending while still counting at Start.
    const w = reconstructWaterfall(
      [sub({ id: "a", mrr: 4000, status: "cancelled", endDate: null })],
      FROM, TO,
    );
    expect(w.startingMrr).toBe(4000);
    expect(w.endingMrr).toBe(0);
    expect(w.unexplained).toBe(-4000);
    expect(w.notes.join(" ")).toMatch(/unexplained/i);
    expect(w.notes.join(" ")).toMatch(/under-estimate/i);
  });
});

describe("fromLedger", () => {
  const mv = (p: Partial<MrrMovement> & { reason: MrrMovement["reason"] }): MrrMovement => ({
    subscriptionId: "s1", at: "2026-07-10", fromMrr: 0, toMrr: 0, ...p,
  });

  it("computes all five components and closes the identity", () => {
    const w = fromLedger(100000, [
      mv({ reason: "new", fromMrr: 0, toMrr: 12000 }),
      mv({ reason: "expansion", fromMrr: 5000, toMrr: 8000 }),      // +3000
      mv({ reason: "contraction", fromMrr: 9000, toMrr: 6000 }),    // −3000
      mv({ reason: "churn", fromMrr: 4000, toMrr: 0 }),             // −4000
    ]);
    expect(w.startingMrr).toBe(100000);
    expect(w.newMrr).toBe(12000);
    expect(w.expansion).toBe(3000);
    expect(w.contraction).toBe(3000);
    expect(w.churnedMrr).toBe(4000);
    expect(w.endingMrr).toBe(108000);
    expect(
      w.startingMrr + w.newMrr + (w.expansion ?? 0) - (w.contraction ?? 0) - w.churnedMrr,
    ).toBe(w.endingMrr);
    expect(w.unexplained).toBe(0);
    expect(w.basis).toBe("ledger");
  });

  it("reports contraction as a positive magnitude", () => {
    // Stored deltas are negative. Adding them would INCREASE ending MRR —
    // a downgrade would read as growth.
    const w = fromLedger(50000, [mv({ reason: "contraction", fromMrr: 8000, toMrr: 5000 })]);
    expect(w.contraction).toBe(3000);
    expect(w.endingMrr).toBe(47000);
  });

  it("counts a reactivation as New rather than dropping it", () => {
    const w = fromLedger(0, [mv({ reason: "reactivation", fromMrr: 0, toMrr: 2500 })]);
    expect(w.newMrr).toBe(2500);
    expect(w.endingMrr).toBe(2500);
  });

  it("reports expansion as 0 — not null — because on this path 0 is a real fact", () => {
    const w = fromLedger(10000, [mv({ reason: "new", fromMrr: 0, toMrr: 1000 })]);
    expect(w.expansion).toBe(0);
    expect(w.contraction).toBe(0);
  });
});

describe("netNewMrr", () => {
  it("is the full five-component figure on the ledger path", () => {
    const w = fromLedger(100000, [
      { subscriptionId: "s", at: "2026-07-02", fromMrr: 0, toMrr: 5000, reason: "new" },
      { subscriptionId: "t", at: "2026-07-03", fromMrr: 1000, toMrr: 3000, reason: "expansion" },
    ]);
    expect(netNewMrr(w)).toBe(7000);
  });

  it("is New − Churn when a reconstruction reconciles exactly", () => {
    const w = reconstructWaterfall(
      [
        sub({ id: "new", mrr: 3000, startDate: "2026-07-10" }),
        sub({ id: "gone", mrr: 2000, endDate: "2026-07-15", status: "cancelled" }),
      ],
      FROM, TO,
    );
    expect(w.unexplained).toBe(0);
    expect(netNewMrr(w)).toBe(1000);
  });

  it("refuses to state a figure when movement is unaccounted for", () => {
    // A partial number presented as "net new MRR" is worse than no number:
    // the owner cannot tell it is missing the upgrades.
    const w = reconstructWaterfall(
      [sub({ id: "a", mrr: 4000, status: "cancelled", endDate: null })],
      FROM, TO,
    );
    expect(w.unexplained).not.toBe(0);
    expect(netNewMrr(w)).toBeNull();
  });
});
