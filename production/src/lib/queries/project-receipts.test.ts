import { describe, it, expect } from "vitest";
import { receiptMilestones } from "./project-receipts";

describe("receiptMilestones — a new project created from a bank receipt", () => {
  it("receipt is the whole value → one Full payment milestone", () => {
    expect(receiptMilestones(540_000, 540_000)).toEqual([{ label: "Full payment", total_amount: 540_000, due_date: null }]);
  });
  it("receipt is part of it → Advance (this receipt) + Balance (the rest), adding up to the total", () => {
    const m = receiptMilestones(1_000_000, 540_000);
    expect(m.map((x) => x.label)).toEqual(["Advance", "Balance"]);
    expect(m[0].total_amount).toBe(540_000);
    expect(m.reduce((s, x) => s + x.total_amount, 0)).toBe(1_000_000);
  });
});
