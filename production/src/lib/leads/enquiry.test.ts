import { describe, it, expect } from "vitest";
import { MILESTONE_SPLITS, milestonesFor, withGst, interStateFor, pipelineSplit } from "./enquiry";

const split = (k: string) => MILESTONE_SPLITS.find((s) => s.key === k)!;

describe("milestonesFor", () => {
  it("50-50 on ₹5,90,000", () => {
    expect(milestonesFor(590_000, split("50-50")).map((m) => [m.label, m.total_amount]))
      .toEqual([["Advance", 295_000], ["On delivery", 295_000]]);
  });

  it("an odd total: the last milestone takes the remainder, so they add up exactly", () => {
    const ms = milestonesFor(100_001, split("30-40-30"));
    expect(ms.reduce((s, m) => s + m.total_amount, 0)).toBe(100_001);
    expect(ms.map((m) => m.total_amount)).toEqual([30_000, 40_000, 30_001]);
  });

  it("100% advance is one milestone", () => {
    expect(milestonesFor(118_000, split("100"))).toEqual([{ label: "Full payment", total_amount: 118_000, due_date: null }]);
  });
});

describe("withGst", () => {
  it("₹5,00,000 at 18% = ₹5,90,000", () => {
    expect(withGst(500_000, 18)).toEqual({ taxable: 500_000, gst: 90_000, total: 590_000 });
  });
});

describe("interStateFor", () => {
  it("Delhi client, Delhi seller → CGST+SGST; Maharashtra seller → IGST", () => {
    expect(interStateFor("07", "07")).toBe(false);
    expect(interStateFor("27", "07")).toBe(true);
  });
  it("unknown state → null, the operator is asked", () => {
    expect(interStateFor("07", null)).toBeNull();
    expect(interStateFor("", "07")).toBeNull();
  });
});

describe("pipelineSplit", () => {
  it("licences and projects summed apart; a lead without a type counts as subscription", () => {
    expect(pipelineSplit([
      { enquiry_type: "project", value: 500_000 },
      { enquiry_type: "subscription", value: 88_320 },
      { enquiry_type: null, value: 10_000 },
      { enquiry_type: "project", value: null },
    ])).toEqual({ subscription: 98_320, project: 500_000 });
  });
});
