import { describe, it, expect } from "vitest";
import { parseGstr2b, reconcile2b, type BooksItcRow, type Gstr2bInvoice } from "./gstr2b";

const G = "06AABCF1234A1Z5";
const inv = (over: Partial<Gstr2bInvoice>): Gstr2bInvoice => ({ gstin: G, invoiceNo: "FB-1", date: "2026-08-31", value: 11800, taxable: 10000, igst: 1800, cgst: 0, sgst: 0, itcAvailable: true, ...over });
const row = (over: Partial<BooksItcRow>): BooksItcRow => ({ id: "e1", source: "expense", vendor: "Facebook", vendorGstin: G, billNo: "FB-1", date: "2026-08-31", taxable: 10000, igst: 1800, cgst: 0, sgst: 0, ...over });

describe("GSTR-2B JSON", () => {
  it("parses the portal envelope: suppliers → invoices → items, dates to ISO", () => {
    const p = parseGstr2b({ data: { rtnprd: "082026", docdata: { b2b: [
      { ctin: G, trdnm: "META", inv: [{ inum: "FB/1", dt: "31-08-2026", val: 11800, itcavl: "Y", items: [{ num: 1, det: { txval: 10000, igst: 1800 } }] }] },
    ] } } });
    expect(p.period).toBe("082026");
    expect(p.invoices[0]).toMatchObject({ gstin: G, supplierName: "META", invoiceNo: "FB/1", date: "2026-08-31", igst: 1800, taxable: 10000, itcAvailable: true });
  });
  it("says when it is not a 2B file", () => {
    expect(parseGstr2b({ hello: 1 }).invoices).toEqual([]);
    expect(parseGstr2b({ docdata: { b2b: "x" } }).errors[0]).toMatch(/GSTR-2B/);
  });
});

describe("2B ↔ books", () => {
  it("matches on GSTIN + invoice number ignoring punctuation, falls back to GSTIN + tax", () => {
    const r = reconcile2b(
      [inv({ invoiceNo: "FB/1" }), inv({ invoiceNo: "G-77", igst: 900, taxable: 5000 })],
      [row({ billNo: "fb-1" }), row({ id: "e2", billNo: null, igst: 900, taxable: 5000 })],
    );
    expect(r.matched).toHaveLength(2);
    expect(r.onlyIn2b).toHaveLength(0);
    expect(r.onlyInBooks).toHaveLength(0);
    expect(r.claimable.total).toBe(2700);
  });
  it("a tax mismatch is its own list; books-only is held; 2B-only is unbooked", () => {
    const r = reconcile2b(
      [inv({ invoiceNo: "FB-1", igst: 1700 }), inv({ invoiceNo: "NEW-9", igst: 360, taxable: 2000 })],
      [row({ billNo: "FB-1" }), row({ id: "e3", billNo: "X-1", igst: 180, taxable: 1000 })],
    );
    expect(r.amountDiffers).toHaveLength(1);
    expect(r.amountDiffers[0].diff).toBe(-100);
    expect(r.onlyIn2b.map((x) => x.invoiceNo)).toEqual(["NEW-9"]);
    expect(r.onlyInBooks.map((x) => x.id)).toEqual(["e3"]);
    expect(r.claimable.total).toBe(1700);   // at the 2B figure
    expect(r.held).toBe(180);
    expect(r.unbooked).toBe(360);
  });
  it("2B rows marked ITC not available do not count as claimable even when matched", () => {
    const r = reconcile2b([inv({ itcAvailable: false })], [row({})]);
    expect(r.matched).toHaveLength(1);
    expect(r.claimable.total).toBe(0);
  });
  it("a books row without a GSTIN can never match", () => {
    const r = reconcile2b([inv({})], [row({ vendorGstin: null })]);
    expect(r.onlyInBooks).toHaveLength(1);
    expect(r.onlyIn2b).toHaveLength(1);
  });
});
