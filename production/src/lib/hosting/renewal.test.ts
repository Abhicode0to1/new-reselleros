import { describe, it, expect } from "vitest";
import { HOSTING_RENEWAL_PLAN, hostingRenewalCommandId, hostingRenewalEnabled, monthsFromRenewalLines } from "./renewal";

describe("hosting renewal helpers (25 Sep 2026)", () => {
  it("only an exact 1 turns it on", () => {
    expect(hostingRenewalEnabled({})).toBe(false);
    for (const v of ["", "true", "yes", " 1"]) expect(hostingRenewalEnabled({ HOSTING_RENEWAL_LIVE: v }), v).toBe(false);
    expect(hostingRenewalEnabled({ HOSTING_RENEWAL_LIVE: "1" })).toBe(true);
  });

  it("one command id per row per IST day, distinct from the others", () => {
    expect(hostingRenewalCommandId("R1", new Date("2026-09-25T05:00:00Z"))).toBe("rsos-hostrenew-R1-2026-09-25");
    expect(hostingRenewalCommandId("R1", new Date("2026-09-25T20:00:00Z"))).toBe("rsos-hostrenew-R1-2026-09-26");
    expect(HOSTING_RENEWAL_PLAN).toBe("hosting-renewal");
  });

  it("the renewal's length comes from the line's term — monthly is 1, yearly is 12", () => {
    expect(monthsFromRenewalLines([{ commitment: "monthly" }])).toBe(1);
    expect(monthsFromRenewalLines([{ commitment: "annual_yearly" }])).toBe(12);
  });

  it("anything unclear is null, so the worker holds rather than guesses", () => {
    expect(monthsFromRenewalLines([])).toBeNull();
    expect(monthsFromRenewalLines(null)).toBeNull();
    expect(monthsFromRenewalLines([{ name: "no commitment" }])).toBeNull();
    expect(monthsFromRenewalLines([{ commitment: "monthly" }, { commitment: "annual_yearly" }])).toBeNull();
    expect(monthsFromRenewalLines([{ commitment: "annual_monthly" }])).toBeNull();
  });
});
