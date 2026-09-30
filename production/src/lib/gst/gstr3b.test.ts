import { describe, it, expect } from "vitest";
import { computeGstr3b, gstr3bRows } from "./gstr3b";

const H = (igst = 0, cgst = 0, sgst = 0) => ({ igst, cgst, sgst });

describe("GSTR-3B worksheet", () => {
  const g = computeGstr3b({
    output: [{ taxableValue: 500_000, heads: H(0, 45_000, 45_000) }, { taxableValue: 100_000, heads: H(18_000) }],
    itc: [H(0, 900, 900), H(2_700)],
    blocked17: [H(0, 90, 90)],
    notIn2b: 180,
    rcm: [{ amount: 50_000, tax: 9_000 }],
  });

  it("3.1(a) and 3.1(d)", () => {
    expect(g.outTaxable).toBe(600_000);
    expect(g.out).toEqual(H(18_000, 45_000, 45_000));
    expect(g.rcmTaxable).toBe(50_000);
    expect(g.rcmTax).toBe(9_000);
  });

  it("4(A)(5) is gross of the 17(5) part, 4(B)(1) reverses it, 4(C) nets and adds the RCM credit", () => {
    expect(g.itcAll).toEqual(H(2_700, 990, 990));
    expect(g.rev17).toEqual(H(0, 90, 90));
    expect(g.itcNet).toEqual(H(2_700 + 9_000, 900, 900));
    expect(g.itcRcm).toBe(9_000);
  });

  it("cash: RCM tax always, plus uncovered output per head", () => {
    expect(g.pay.igst).toBe(9_000 + Math.max(0, 18_000 - 11_700));
    expect(g.pay.cgst).toBe(45_000 - 900);
    expect(g.pay.sgst).toBe(45_000 - 900);
  });

  it("kaccha / no-GSTIN GST is reported outside the boxes", () => {
    expect(g.notIn2b).toBe(180);
    const rows = gstr3bRows(g);
    expect(rows.map((r) => r[0])).toEqual(["3.1(a)", "3.1(d)", "4(A)(3)", "4(A)(5)", "4(B)(1)", "4(C)", "Net", "—"]);
  });

  it("no RCM, no blocked → only the classic four rows", () => {
    const g2 = computeGstr3b({ output: [], itc: [], blocked17: [], notIn2b: 0, rcm: [] });
    expect(gstr3bRows(g2).map((r) => r[0])).toEqual(["3.1(a)", "4(A)(5)", "4(C)", "Net"]);
    expect(g2.pay).toEqual(H());
  });
});

describe("WC-gst: 3.1(b) zero-rated and 3.2 unregistered inter-state", () => {
  const g = computeGstr3b({
    output: [
      { taxableValue: 500_000, heads: H(0, 45_000, 45_000) },
      { taxableValue: 100_000, heads: H(18_000), unregInterPos: "27-Maharashtra" },
      { taxableValue: 50_000, heads: H(9_000), unregInterPos: "27-Maharashtra" },
      { taxableValue: -10_000, heads: H(-1_800), unregInterPos: "27-Maharashtra" },   // credit note
      { taxableValue: 20_000, heads: H(3_600), unregInterPos: "09-Uttar Pradesh" },
      { taxableValue: 200_000, heads: H(), zeroRated: true },                           // export under LUT
      { taxableValue: 100_000, heads: H(18_000), zeroRated: true },                     // export with IGST
    ],
    itc: [], blocked17: [], notIn2b: 0, rcm: [],
  });

  it("exports leave 3.1(a) and go to 3.1(b)", () => {
    expect(g.outTaxable).toBe(500_000 + 100_000 + 50_000 - 10_000 + 20_000);
    expect(g.out.igst).toBe(18_000 + 9_000 - 1_800 + 3_600);
    expect(g.zeroTaxable).toBe(300_000);
    expect(g.zeroIgst).toBe(18_000);
  });

  it("IGST on exports with payment is still payable", () => {
    expect(g.pay.igst).toBe(18_000 + 9_000 - 1_800 + 3_600 + 18_000);
  });

  it("3.2 is per place of supply, netted, sorted", () => {
    expect(g.unregInter).toEqual([
      { pos: "09-Uttar Pradesh", taxable: 20_000, igst: 3_600 },
      { pos: "27-Maharashtra", taxable: 140_000, igst: 25_200 },
    ]);
    expect(gstr3bRows(g).map((r) => r[0])).toEqual(["3.1(a)", "3.1(b)", "3.2", "3.2", "4(A)(5)", "4(C)", "Net"]);
  });

  it("advances net into 3.1(a): 11A adds, 11B takes back", () => {
    const a = computeGstr3b({
      output: [{ taxableValue: 10_000, heads: H(0, 900, 900) }, { taxableValue: -5_000, heads: H(0, -450, -450) }],
      itc: [], blocked17: [], notIn2b: 0, rcm: [],
    });
    expect(a.outTaxable).toBe(5_000);
    expect(a.out).toEqual(H(0, 450, 450));
  });
});
