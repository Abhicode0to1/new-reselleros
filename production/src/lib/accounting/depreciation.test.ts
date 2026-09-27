import { describe, it, expect } from "vitest";
import { depreciationSchedule, wdvAtFyEnd, bookValueNow, registerSummary, fyStartOf, type AssetLike } from "./depreciation";

const laptop: AssetLike = { id: "a", name: "MacBook", block: "computers", cost: 120_000, put_to_use: "2024-06-10" };

describe("Income-tax WDV depreciation", () => {
  it("40% on the opening WDV each year, whole rupees", () => {
    const s = depreciationSchedule(laptop, 2026);
    expect(s.map((r) => [r.fyLabel, r.depreciation, r.closing])).toEqual([
      ["2024-25", 48_000, 72_000],
      ["2025-26", 28_800, 43_200],
      ["2026-27", 17_280, 25_920],
    ]);
    expect(s[0].halfRate).toBe(false);
  });

  it("put to use under 180 days in the year → half rate that year only", () => {
    const late: AssetLike = { ...laptop, put_to_use: "2024-11-15" };   // 137 days to 31 Mar
    const s = depreciationSchedule(late, 2025);
    expect(s[0]).toMatchObject({ ratePct: 20, halfRate: true, depreciation: 24_000, closing: 96_000 });
    expect(s[1]).toMatchObject({ ratePct: 40, depreciation: 38_400 });
    // 4 Oct 2024 → 179 days: half; 3 Oct → 180: full
    expect(depreciationSchedule({ ...laptop, put_to_use: "2024-10-04" }, 2024)[0].halfRate).toBe(true);
    expect(depreciationSchedule({ ...laptop, put_to_use: "2024-10-03" }, 2024)[0].halfRate).toBe(false);
  });

  it("nothing in the year of disposal; the row says the gain or loss", () => {
    const sold: AssetLike = { ...laptop, disposed_on: "2026-07-01", disposal_value: 30_000 };
    const s = depreciationSchedule(sold, 2027);
    expect(s).toHaveLength(3);
    expect(s[2]).toMatchObject({ fy: 2026, depreciation: 0, closing: 0 });
    expect(s[2].note).toMatch(/short-term loss ₹13,200/);
    expect(wdvAtFyEnd(sold, 2027)).toBe(0);
  });

  it("book value today = last year's closing WDV; cost in the year of purchase; 0 once sold", () => {
    expect(bookValueNow(laptop, "2026-09-27")).toBe(43_200);
    expect(bookValueNow({ ...laptop, put_to_use: "2026-05-01" }, "2026-09-27")).toBe(120_000);
    expect(bookValueNow({ ...laptop, disposed_on: "2026-07-01" }, "2026-09-27")).toBe(0);
    expect(bookValueNow(laptop, "2024-01-01")).toBe(0);
  });

  it("register summary groups by block for a year", () => {
    const chair: AssetLike = { id: "b", name: "Chairs", block: "furniture", cost: 40_000, put_to_use: "2025-04-01" };
    const r = registerSummary([laptop, chair], 2026);
    expect(r.byBlock.map((b) => [b.block, b.depreciation, b.closingWdv])).toEqual([
      ["computers", 17_280, 25_920],
      ["furniture", 3_600, 32_400],
    ]);
    expect(r.openingWdv).toBe(43_200 + 36_000);
    expect(r.depreciation).toBe(20_880);
    expect(r.closingWdv).toBe(58_320);
    expect(r.cost).toBe(160_000);
  });

  it("fyStartOf", () => {
    expect(fyStartOf("2026-03-31")).toBe(2025);
    expect(fyStartOf("2026-04-01")).toBe(2026);
  });
});
