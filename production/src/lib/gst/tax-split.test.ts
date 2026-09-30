import { describe, it, expect } from "vitest";
import { splitIntraStateTax, splitTaxHeads } from "./tax-split";
import { gstSplit } from "./gstr1";

describe("splitIntraStateTax — one CGST/SGST rule for invoice and return", () => {
  it("even tax splits evenly", () => {
    expect(splitIntraStateTax(18000)).toEqual({ cgst: 9000, sgst: 9000 });
  });

  it("odd whole-rupee tax: the odd rupee goes to CGST (= Math.round(tax/2), what the invoice PDF prints)", () => {
    expect(splitIntraStateTax(181)).toEqual({ cgst: 91, sgst: 90 });
    expect(splitIntraStateTax(1)).toEqual({ cgst: 1, sgst: 0 });
    expect(splitIntraStateTax(15253)).toEqual({ cgst: Math.round(15253 / 2), sgst: 15253 - Math.round(15253 / 2) });
  });

  it("always sums back to the tax", () => {
    for (const t of [0, 1, 2, 3, 17, 181, 999, 12345, 274.42, 274.43, 0.01, 100.99]) {
      const { cgst, sgst } = splitIntraStateTax(t);
      expect(Math.round((cgst + sgst) * 100)).toBe(Math.round(t * 100));
    }
  });

  it("tax with paise splits at the paise, not the rupee", () => {
    expect(splitIntraStateTax(274.42)).toEqual({ cgst: 137.21, sgst: 137.21 });
    expect(splitIntraStateTax(274.43)).toEqual({ cgst: 137.22, sgst: 137.21 });
  });

  it("a credit note (negative) mirrors the invoice's split exactly", () => {
    expect(splitIntraStateTax(-181)).toEqual({ cgst: -91, sgst: -90 });
    expect(splitIntraStateTax(-274.43)).toEqual({ cgst: -137.22, sgst: -137.21 });
  });

  it("zero / non-finite → zero heads, never -0", () => {
    expect(splitIntraStateTax(0)).toEqual({ cgst: 0, sgst: 0 });
    expect(Object.is(splitIntraStateTax(-1).sgst, -0)).toBe(false);
    expect(splitIntraStateTax(Number.NaN)).toEqual({ cgst: 0, sgst: 0 });
  });

  it("inter-state is all IGST", () => {
    expect(splitTaxHeads(181, true)).toEqual({ igst: 181, cgst: 0, sgst: 0 });
    expect(splitTaxHeads(181, false)).toEqual({ igst: 0, cgst: 91, sgst: 90 });
  });

  it("GSTR-1's gstSplit uses the same rule (was Math.trunc → CGST 90 / SGST 91)", () => {
    expect(gstSplit({ gst: 181, interState: false })).toEqual({ igst: 0, cgst: 91, sgst: 90 });
  });
});
