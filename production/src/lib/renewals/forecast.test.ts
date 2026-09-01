/**
 * Renewal forecast — mahina-war baalti, flex ALAG (jod me nahi), horizon ke
 * bahar ka bahar.
 */
import { describe, it, expect } from "vitest";
import { renewalForecast } from "./forecast";

const sub = (over: Record<string, unknown>) => ({
  status: "active", mrr: 1000, term_months: 12, renewal_date: "2026-10-15",
  ...over,
}) as never;

describe("renewalForecast", () => {
  it("annual sub apne renewal-mahine ki baalti me mrr×12 ke saath", () => {
    const f = renewalForecast([sub({ mrr: 9046, renewal_date: "2026-10-01" })], "2026-09-01");
    const oct = f.months.find((m) => m.key === "2026-10")!;
    expect(oct.amount).toBe(108552);
    expect(oct.count).toBe(1);
    expect(f.totalAmount).toBe(108552);
  });

  it("FLEX (term 1 mahina) jod me NAHI — alag run-rate me (aaj hi ka 12× sabak)", () => {
    const f = renewalForecast(
      [sub({ term_months: 1, mrr: 4875 }), sub({ mrr: 1000, renewal_date: "2026-09-20" })],
      "2026-09-01",
    );
    expect(f.flexMonthlyRunRate).toBe(4875);
    expect(f.flexCount).toBe(1);
    expect(f.totalAmount).toBe(12000); // sirf annual wala
  });

  it("horizon ke bahar / cancelled / bina-tareekh ke bahar rehte hain", () => {
    const f = renewalForecast(
      [
        sub({ renewal_date: "2027-06-01" }),                 // 6-mahine ke horizon ke baad
        sub({ status: "cancelled", renewal_date: "2026-09-10" }),
        sub({ renewal_date: null }),
      ],
      "2026-09-01",
    );
    expect(f.totalCount).toBe(0);
    expect(f.totalAmount).toBe(0);
  });

  it("mahine kram me, saal ka palta sahi (Dec → Jan)", () => {
    const f = renewalForecast([], "2026-11-15", 4);
    expect(f.months.map((m) => m.key)).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(f.months[2].label).toBe("Jan 2027");
  });
});
