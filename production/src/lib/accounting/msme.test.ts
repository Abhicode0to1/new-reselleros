import { describe, it, expect } from "vitest";
import { isUdyam, msmeSummary, UDYAM_RE } from "./msme";

describe("Udyam format", () => {
  it("accepts UDYAM-SS-00-0000000 in any case, rejects near-misses", () => {
    expect(isUdyam("UDYAM-DL-01-0012345")).toBe(true);
    expect(isUdyam(" udyam-mh-23-0000001 ")).toBe(true);
    expect(isUdyam("UDYAM-DL-1-0012345")).toBe(false);
    expect(isUdyam("UDYAM-D1-01-0012345")).toBe(false);
    expect(isUdyam("UAM-DL-01-0012345")).toBe(false);
    expect(isUdyam(null)).toBe(false);
  });
  it("matches the DB check constraint pattern exactly", () => {
    expect(UDYAM_RE.source).toBe("^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$");
  });
});

describe("msmeSummary", () => {
  it("splits what is past 45 days from the rest, per vendor", () => {
    const s = msmeSummary([
      { amount_due: 10000, over_limit: true, vendor_id: "v1" },
      { amount_due: 5000, over_limit: false, vendor_id: "v1" },
      { amount_due: 7000, over_limit: true, vendor_id: "v2" },
      { amount_due: 3000, over_limit: true, vendor_id: "v2" },
    ]);
    expect(s).toEqual({ due: 25000, overDue: 20000, overCount: 3, vendorsOver: 2 });
  });
});
