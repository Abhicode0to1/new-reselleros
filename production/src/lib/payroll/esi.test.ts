import { describe, it, expect } from "vitest";
import { computeEsi, esiContributionPeriodStart, esiStickyCovered, ESI_WAGE_CEILING } from "./esi";

describe("ESI contribution periods", () => {
  it("Apr–Sep starts in April, Oct–Mar starts in October of the right year", () => {
    expect(esiContributionPeriodStart("2026-04")).toBe("2026-04");
    expect(esiContributionPeriodStart("2026-09")).toBe("2026-04");
    expect(esiContributionPeriodStart("2026-10")).toBe("2026-10");
    expect(esiContributionPeriodStart("2027-02")).toBe("2026-10");
  });

  it("covered earlier in the same period → stays covered above the ceiling", () => {
    const history = [{ period: "2026-04", esi: 150 }, { period: "2026-05", esi: 150 }];
    expect(esiStickyCovered("2026-08", history)).toBe(true);
    expect(esiStickyCovered("2026-11", history)).toBe(false);     // new period, fresh test
    expect(esiStickyCovered("2026-08", [{ period: "2026-06", esi: 0 }])).toBe(false);
    expect(esiStickyCovered("2026-04", history)).toBe(false);     // nothing before the first month
  });

  it("computeEsi honours the sticky flag only above the ceiling", () => {
    const above = ESI_WAGE_CEILING + 5000;
    expect(computeEsi(above, true).applicable).toBe(false);
    const s = computeEsi(above, true, true);
    expect(s.applicable).toBe(true);
    expect(s.employee).toBe(Math.ceil(above * 0.0075));
    expect(computeEsi(above, false, true).applicable).toBe(false);   // owner said not covered
  });
});
