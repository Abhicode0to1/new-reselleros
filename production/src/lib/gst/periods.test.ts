import { describe, it, expect } from "vitest";
import { gstLastMonth, gstMonth, gstThisMonth, gstThisQuarter, istRangeUtc } from "./periods";

describe("GST periods are IST, not UTC", () => {
  // 30 Sep 2026 19:00 UTC = 1 Oct 2026 00:30 IST
  const justAfterIstMidnight = new Date("2026-09-30T19:00:00Z");

  it("this month flips at IST midnight, not UTC midnight", () => {
    expect(gstThisMonth(justAfterIstMidnight)).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(gstThisMonth(new Date("2026-09-30T18:29:00Z"))).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("last month = the IST previous month; across a year end too", () => {
    expect(gstLastMonth(justAfterIstMidnight)).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(gstLastMonth(new Date("2026-12-31T19:00:00Z"))).toMatchObject({ from: "2026-12-01", to: "2026-12-31" });
    expect(gstLastMonth(new Date("2027-01-15T06:00:00Z"))).toMatchObject({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("quarter by IST month", () => {
    expect(gstThisQuarter(justAfterIstMidnight)).toEqual({ from: "2026-10-01", to: "2026-12-31", label: "Q4 2026" });
    expect(gstThisQuarter(new Date("2026-09-30T12:00:00Z"))).toEqual({ from: "2026-07-01", to: "2026-09-30", label: "Q3 2026" });
  });

  it("month label and Feb end", () => {
    expect(gstMonth("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29", label: expect.stringMatching(/February 2028/) });
  });

  it("timestamp bounds start at IST midnight", () => {
    expect(istRangeUtc("2026-09-01", "2026-09-30")).toEqual({
      fromUtc: "2026-08-31T18:30:00.000Z",
      toUtcExclusive: "2026-09-30T18:30:00.000Z",
    });
  });
});
