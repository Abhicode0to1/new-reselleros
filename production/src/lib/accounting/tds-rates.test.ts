import { describe, it, expect } from "vitest";
import { defaultTds, tdsBase, TDS_SECTION_RATES } from "./tds-rates";

describe("default TDS per section", () => {
  it("194H commission at 2%: ₹5,00,000 → ₹10,000", () => {
    expect(defaultTds("194H", 5_00_000)).toBe(10_000);
  });

  it("194J 10%, 194C 2%, 194I 10%, 194A 10%, 194Q 0.1%", () => {
    expect(defaultTds("194J", 1_00_000)).toBe(10_000);
    expect(defaultTds("194C", 1_00_000)).toBe(2_000);
    expect(defaultTds("194I", 50_000)).toBe(5_000);
    expect(defaultTds("194A", 12_345)).toBe(1_235);
    expect(defaultTds("194Q", 60_00_000)).toBe(6_000);
  });

  it("an unknown section has no default — the operator types it", () => {
    expect(defaultTds("192", 1_00_000)).toBeNull();
    expect(defaultTds("", 1_00_000)).toBeNull();
  });

  it("the other rate is named where a section has two", () => {
    expect(TDS_SECTION_RATES["194C"].note).toMatch(/1%/);
    expect(TDS_SECTION_RATES["194J"].note).toMatch(/2%/);
  });
});

describe("tdsBase — TDS is on the value before GST", () => {
  it("a ₹1,18,000 bill with ₹18,000 GST → base ₹1,00,000", () => {
    expect(tdsBase(1_18_000, 18_000)).toBe(1_00_000);
  });
  it("no GST → the whole amount; never negative", () => {
    expect(tdsBase(5_00_000, 0)).toBe(5_00_000);
    expect(tdsBase(100, 500)).toBe(0);
  });
});
