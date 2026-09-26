import { describe, it, expect } from "vitest";
import { commissionTdsView, fyStartOf, TDS_194H_THRESHOLD, TDS_194H_RATE_PCT } from "./commission-tds";

describe("s.194H on commission to one person", () => {
  it("the limit is ₹20,000 a year and the rate 2%", () => {
    expect(TDS_194H_THRESHOLD).toBe(20_000);
    expect(TDS_194H_RATE_PCT).toBe(2);
  });

  it("₹20,000 on its own is AT the limit, not over it — no TDS yet", () => {
    const v = commissionTdsView({ amount: 20_000, earlier: 0, earlierWithoutTds: 0 });
    expect(v.crosses).toBe(false);
    expect(v.tdsOnThis).toBe(400);
  });

  it("₹20,000 after ₹5,000 earlier crosses it — and the earlier ₹5,000 is caught up", () => {
    const v = commissionTdsView({ amount: 20_000, earlier: 5_000, earlierWithoutTds: 5_000 });
    expect(v.crosses).toBe(true);
    expect(v.yearTotal).toBe(25_000);
    expect(v.tdsOnThis).toBe(400);
    expect(v.earlierUntaxed).toBe(5_000);
  });
});

describe("fyStartOf", () => {
  it("April starts the year; March belongs to the previous one", () => {
    expect(fyStartOf("2026-09-26")).toBe("2026-04-01");
    expect(fyStartOf("2027-03-31")).toBe("2026-04-01");
    expect(fyStartOf("2026-04-01")).toBe("2026-04-01");
  });
});
