import { describe, it, expect } from "vitest";
import { checkExpense, checkVendorBill, checkPayment, checkCustomer, itcDeadline, hasStop, LAW } from "./entry-rules";

const TODAY = "2026-10-02";
const DELHI = { stateCode: "07", gstin: null };
const codes = (w: { code: string }[]) => w.map((x) => x.code);

describe("expenses — Income-tax", () => {
  it("cash above ₹10,000 is a 40A(3) stop; by bank it is fine", () => {
    expect(codes(checkExpense({ amount: 12_000, category: "Office Supplies", paid_by: "cash" }, TODAY))).toEqual(["cash-40A3"]);
    expect(hasStop(checkExpense({ amount: 12_000, category: "Office Supplies", paid_by: "cash" }, TODAY))).toBe(true);
    expect(checkExpense({ amount: 12_000, category: "Office Supplies", paid_by: "upi" }, TODAY)).toEqual([]);
    expect(checkExpense({ amount: LAW.CASH_EXPENSE_LIMIT, category: "Travel", paid_by: "cash" }, TODAY)).toEqual([]);
  });
  it("TDS reminders at the FY 2025-26 thresholds", () => {
    expect(codes(checkExpense({ amount: 60_000, category: "Professional Services" }, TODAY))).toEqual(["tds-194J"]);
    expect(checkExpense({ amount: 40_000, category: "Professional Services" }, TODAY)).toEqual([]);
    expect(codes(checkExpense({ amount: 25_000, category: "Commission / Incentive (agents)" }, TODAY))).toEqual(["tds-194H"]);
    expect(codes(checkExpense({ amount: 55_000, category: "Office Rent" }, TODAY))).toEqual(["tds-194I"]);
    expect(codes(checkExpense({ amount: 35_000, category: "Repairs & Maintenance" }, TODAY))).toEqual(["tds-194C"]);
  });
  it("TDS thresholds are yearly: this payment plus what was already paid this FY", () => {
    expect(checkExpense({ amount: 20_000, category: "Professional Services", ytd: 0 }, TODAY)).toEqual([]);
    const w = checkExpense({ amount: 20_000, category: "Professional Services", ytd: 40_000 }, TODAY);
    expect(codes(w)).toEqual(["tds-194J"]);
    expect(w[0].message).toContain("₹40,000 already paid");
    expect(codes(checkExpense({ amount: 10_000, category: "Repairs & Maintenance", ytd: 95_000 }, TODAY))).toEqual(["tds-194C"]);
  });
  it("a future-dated expense is flagged", () => {
    expect(codes(checkExpense({ amount: 100, category: "Travel", expense_date: "2026-10-09" }, TODAY))).toEqual(["future-date"]);
  });
});

describe("vendor bills — GST input", () => {
  const base = { vendor_gstin: "07AAPFU0939F1Z1", bill_no: "INV-1", bill_date: "2026-09-30", subtotal: 10_000, cgst: 900, sgst: 900, igst: 0, total: 11_800 };

  it("a clean intra-state bill raises nothing", () => {
    // Delhi vendor GSTIN prefix 07 must pass the checksum for the state rule to apply;
    // a GSTIN that fails it reads as "no state", which is also nothing to flag here.
    expect(checkVendorBill(base, DELHI, TODAY).filter((w) => w.code !== "gst-head-inter")).toEqual([]);
  });
  it("IGST together with CGST/SGST is a stop", () => {
    const w = checkVendorBill({ ...base, igst: 1800 }, DELHI, TODAY);
    expect(codes(w)).toContain("gst-both-heads");
    expect(hasStop(w)).toBe(true);
  });
  it("unequal CGST and SGST", () => {
    expect(codes(checkVendorBill({ ...base, sgst: 500, total: 11_400 }, DELHI, TODAY))).toContain("gst-cgst-sgst");
  });
  it("GST without the vendor's GSTIN cannot be claimed", () => {
    expect(codes(checkVendorBill({ ...base, vendor_gstin: null }, DELHI, TODAY))).toContain("gst-no-gstin");
  });
  it("wrong head for the vendor's state — using a GSTIN that passes the checksum", () => {
    const mh = "27AAPFU0939F1ZV"; // Maharashtra, valid
    expect(codes(checkVendorBill({ ...base, vendor_gstin: mh }, DELHI, TODAY))).toContain("gst-head-inter");
    expect(codes(checkVendorBill({ ...base, vendor_gstin: mh, cgst: 0, sgst: 0, igst: 1800 }, { stateCode: "27", gstin: null }, TODAY))).toContain("gst-head-intra");
    expect(codes(checkVendorBill({ ...base, vendor_gstin: mh, cgst: 0, sgst: 0, igst: 1800 }, DELHI, TODAY))).not.toContain("gst-head-inter");
  });
  it("a bill made out to someone else's GSTIN", () => {
    expect(codes(checkVendorBill({ ...base, buyer_gstin: "27AAPFU0939F1ZV" }, { stateCode: "07", gstin: "07AAACA1234A1Z5" }, TODAY))).toContain("gst-not-our-gstin");
  });
  it("totals that do not add up, and a missing bill number", () => {
    const w = codes(checkVendorBill({ ...base, total: 12_500, bill_no: null }, DELHI, TODAY));
    expect(w).toContain("bill-total");
    expect(w).toContain("gst-no-bill-no");
    expect(codes(checkVendorBill({ ...base, total: 11_801 }, DELHI, TODAY))).not.toContain("bill-total");
  });
  it("ITC deadline is 30 Nov after the bill's financial year (s.16(4))", () => {
    expect(itcDeadline("2025-03-15")).toBe("2025-11-30");
    expect(itcDeadline("2025-04-01")).toBe("2026-11-30");
    expect(codes(checkVendorBill({ ...base, bill_date: "2025-02-10" }, DELHI, TODAY))).toContain("itc-time-barred");
    expect(codes(checkVendorBill({ ...base, bill_date: "2025-06-10" }, DELHI, TODAY))).not.toContain("itc-time-barred");
  });
  it("paying a large bill in cash is a 40A(3) stop", () => {
    expect(hasStop(checkVendorBill({ ...base, paid_by: "cash" }, DELHI, TODAY))).toBe(true);
  });
});

describe("money received", () => {
  it("₹2 lakh or more in cash is a 269ST stop; just under is not", () => {
    expect(hasStop(checkPayment({ amount: 2_00_000, method: "cash" }))).toBe(true);
    expect(hasStop(checkPayment({ amount: 1_99_999, method: "cash" }))).toBe(false);
    expect(hasStop(checkPayment({ amount: 5_00_000, method: "neft" }))).toBe(false);
  });
  it("reminds that a business customer may deduct TDS", () => {
    expect(codes(checkPayment({ amount: 80_000, method: "neft" }))).toEqual(["tds-by-customer"]);
  });
});

describe("customers", () => {
  it("a GSTIN that fails the check digit is flagged with what was typed", () => {
    const [w] = checkCustomer({ gstinTyped: "27AAAAA0000A1Z0", gstinValid: false });
    expect(w.code).toBe("gstin-invalid");
    expect(w.message).toContain("27AAAAA0000A1Z0");
    expect(checkCustomer({ gstinTyped: null, gstinValid: false })).toEqual([]);
  });
});
