import { describe, it, expect } from "vitest";
import { LOSS_REASONS, isLossReason, lossReasonLabel, lossBreakdown } from "./loss-reasons";

const lost = (over: Record<string, unknown> = {}) => ({
  stage: "lost", value: 10_000, lost_reason: "price", lost_at: "2026-08-01T00:00:00.000Z", ...over,
}) as Parameters<typeof lossBreakdown>[0][number];

describe("LOSS_REASONS", () => {
  it("matches the CHECK constraint in migration 0225 exactly", () => {
    // If these drift, the dialog offers a code the database will reject.
    expect(LOSS_REASONS.map((r) => r.code)).toEqual([
      "price", "competitor", "no_response", "timing", "not_qualified", "other",
    ]);
  });

  it("gives every reason a label and a disambiguating hint", () => {
    for (const r of LOSS_REASONS) {
      expect(r.label.length).toBeGreaterThan(0);
      expect(r.hint.length).toBeGreaterThan(0);
    }
  });
});

describe("isLossReason", () => {
  it("accepts only known codes", () => {
    expect(isLossReason("price")).toBe(true);
    expect(isLossReason("competitor")).toBe(true);
    expect(isLossReason("Price")).toBe(false);   // case-sensitive: DB codes are lowercase
    expect(isLossReason("budget")).toBe(false);
    expect(isLossReason(null)).toBe(false);
    expect(isLossReason(undefined)).toBe(false);
    expect(isLossReason(42)).toBe(false);
  });
});

describe("lossReasonLabel", () => {
  it("maps codes to labels and is honest about gaps", () => {
    expect(lossReasonLabel("no_response")).toBe("No response");
    // Deals lost before this feature shipped have no code — say so, don't guess.
    expect(lossReasonLabel(null)).toBe("Not recorded");
    expect(lossReasonLabel("")).toBe("Not recorded");
    expect(lossReasonLabel("something_removed_later")).toBe("Not recorded");
  });
});

describe("lossBreakdown", () => {
  it("ignores everything that isn't lost", () => {
    const rows = lossBreakdown([
      lost(), lost({ stage: "won" }), lost({ stage: "quote" }),
    ]);
    expect(rows.reduce((s, r) => s + r.count, 0)).toBe(1);
  });

  it("groups by reason and sorts by VALUE lost, not count", () => {
    // One big competitor loss should outrank three small price losses — the
    // owner cares about the money, not the tally.
    const rows = lossBreakdown([
      lost({ lost_reason: "price", value: 10_000 }),
      lost({ lost_reason: "price", value: 10_000 }),
      lost({ lost_reason: "price", value: 10_000 }),
      lost({ lost_reason: "competitor", value: 500_000 }),
    ]);
    expect(rows[0]).toMatchObject({ code: "competitor", count: 1, value: 500_000 });
    expect(rows[1]).toMatchObject({ code: "price", count: 3, value: 30_000 });
  });

  it("reports un-recorded losses instead of hiding them", () => {
    // Dropping these would make the percentages read as if every loss had been
    // explained — false confidence is worse than a visible gap.
    const rows = lossBreakdown([
      lost({ lost_reason: "price" }),
      lost({ lost_reason: null }),
      lost({ lost_reason: "not_a_real_code" }),
    ]);
    const un = rows.find((r) => r.code === "unrecorded");
    expect(un).toBeDefined();
    expect(un!.count).toBe(2);
    expect(un!.label).toBe("Not recorded");
  });

  it("percentages are of lost count and add up to ~100", () => {
    const rows = lossBreakdown([
      lost({ lost_reason: "price" }), lost({ lost_reason: "price" }),
      lost({ lost_reason: "timing" }), lost({ lost_reason: "timing" }),
    ]);
    expect(rows.every((r) => r.pct === 50)).toBe(true);
    expect(rows.reduce((s, r) => s + r.pct, 0)).toBe(100);
  });

  it("treats a null value as zero rather than NaN", () => {
    const rows = lossBreakdown([lost({ value: null })]);
    expect(rows[0].value).toBe(0);
  });

  it("filters by lost_at when a window is given", () => {
    const rows = lossBreakdown([
      lost({ lost_reason: "price",      lost_at: "2026-08-10T00:00:00.000Z" }),
      lost({ lost_reason: "competitor", lost_at: "2026-01-01T00:00:00.000Z" }),
    ], new Date("2026-07-01T00:00:00.000Z"));
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe("price");
  });

  it("excludes undated losses from a windowed query, but keeps them unwindowed", () => {
    const rows = [lost({ lost_at: null })];
    expect(lossBreakdown(rows, new Date("2026-01-01T00:00:00.000Z"))).toHaveLength(0);
    expect(lossBreakdown(rows)).toHaveLength(1);
  });

  it("returns an empty list when nothing is lost", () => {
    expect(lossBreakdown([])).toEqual([]);
    expect(lossBreakdown([lost({ stage: "won" })])).toEqual([]);
  });
});
