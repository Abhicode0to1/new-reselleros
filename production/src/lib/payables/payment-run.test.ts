/**
 * R-163 — payment run: urgency order, the bank file's rows, and the form checks.
 */
import { describe, it, expect } from "vitest";
import {
  urgencyOf, sortPayables, bankFileRows, paymentMode, RTGS_MIN, NARRATION_MAX,
  IFSC_RE, ACCOUNT_RE, UPI_RE, cleanAccountNo, cleanIfsc, maskAccount, BANK_FILE_HEADERS,
  type Payable, type RunItem, type VendorBank,
} from "./payment-run";

const TODAY = "2026-10-05";
const p = (over: Partial<Payable>): Payable => ({
  source: "vendor_bill", docId: "VB-1", docRef: "R/1", vendorId: "v1", vendorName: "Redington",
  billDate: "2026-09-20", dueDate: null, outstanding: 1000, msmeDeadline: null, msmeOverLimit: false, ...over,
});

describe("urgency", () => {
  it("puts an MSME bill past 45 days above everything", () => {
    expect(urgencyOf(p({ msmeDeadline: "2026-10-01", msmeOverLimit: true }), TODAY)).toEqual({ level: "msme_late", label: "MSME 45 days crossed · 4d late" });
    expect(urgencyOf(p({ msmeDeadline: "2026-10-09" }), TODAY).level).toBe("msme_soon");
  });
  it("reads due dates", () => {
    expect(urgencyOf(p({ dueDate: "2026-10-02" }), TODAY).label).toBe("Overdue 3d");
    expect(urgencyOf(p({ dueDate: TODAY }), TODAY).label).toBe("Due today");
    expect(urgencyOf(p({ dueDate: "2026-10-08" }), TODAY).label).toBe("Due in 3d");
    expect(urgencyOf(p({ dueDate: "2026-11-30" }), TODAY).level).toBe("later");
    expect(urgencyOf(p({ billDate: null }), TODAY).label).toBe("No due date");
  });
  it("sorts: MSME late, overdue, MSME soon, due soon, later — then by date", () => {
    const list = [
      p({ docId: "later", dueDate: "2026-12-01" }),
      p({ docId: "soon", dueDate: "2026-10-07" }),
      p({ docId: "msme-soon", msmeDeadline: "2026-10-08" }),
      p({ docId: "overdue-new", dueDate: "2026-10-04" }),
      p({ docId: "overdue-old", dueDate: "2026-09-01" }),
      p({ docId: "msme-late", msmeDeadline: "2026-09-30", msmeOverLimit: true }),
    ];
    expect(sortPayables(list, TODAY).map((x) => x.docId)).toEqual(["msme-late", "overdue-old", "overdue-new", "msme-soon", "soon", "later"]);
  });
});

const vendors: VendorBank[] = [
  { id: "v1", name: "Redington", bank_account_name: "Redington India Ltd", bank_account_no: "50200012345678", bank_ifsc: "HDFC0001234", upi_id: null },
  { id: "v2", name: "Freelancer", bank_account_name: null, bank_account_no: null, bank_ifsc: null, upi_id: "ravi@okicici" },
  { id: "v3", name: "No Details", bank_account_name: null, bank_account_no: null, bank_ifsc: null, upi_id: null },
];
const item = (over: Partial<RunItem>): RunItem => ({ source: "vendor_bill", doc_id: "VB-1", doc_ref: "R/101", vendor_id: "v1", vendor_name: "Redington", amount: 1000, ...over });

describe("bank file", () => {
  it("is one row per bill, so each transfer matches its bank entry 1:1", () => {
    const f = bankFileRows("PR-202610-001", [
      item({ doc_id: "VB-2", doc_ref: "R/102", amount: 60_000 }),
      item({ doc_id: "VB-1", doc_ref: "R/101", amount: 250_000 }),
      item({ vendor_id: "v2", vendor_name: "Freelancer", doc_id: "EXP-1", doc_ref: null, source: "expense", amount: 4_000 }),
    ], vendors);
    expect(f.missing).toEqual([]);
    expect(f.total).toBe(314_000);
    expect(f.rows).toEqual([
      ["Freelancer", "", "", "ravi@okicici", 4_000, "UPI", "PR-202610-001 EXP-1"],
      ["Redington India Ltd", "50200012345678", "HDFC0001234", "", 250_000, "RTGS", "PR-202610-001 R/101"],
      ["Redington India Ltd", "50200012345678", "HDFC0001234", "", 60_000, "NEFT", "PR-202610-001 R/102"],
    ]);
    expect(f.rows[0]).toHaveLength(BANK_FILE_HEADERS.length);
  });
  it("matches a vendor by name when the bill has no vendor id", () => {
    const f = bankFileRows("PR-1", [item({ vendor_id: null, vendor_name: "  redington " })], vendors);
    expect(f.rows[0][1]).toBe("50200012345678");
  });
  it("lists vendors without bank details instead of writing a bad row", () => {
    const f = bankFileRows("PR-1", [item({}), item({ vendor_id: "v3", vendor_name: "No Details", doc_id: "VB-9" }), item({ vendor_id: null, vendor_name: "Unknown Co", doc_id: "VB-8" })], vendors);
    expect(f.missing).toEqual(["No Details", "Unknown Co"]);
    expect(f.rows).toHaveLength(1);
    expect(f.total).toBe(1000);
  });
  it("keeps the narration within what banks accept", () => {
    const f = bankFileRows("PR-202610-001", [item({ doc_ref: "INV/2026-27/VERY-LONG-BILL-NUMBER-0001" })], vendors);
    expect(String(f.rows[0][6]).length).toBeLessThanOrEqual(NARRATION_MAX);
  });
  it("picks RTGS from ₹2 lakh, NEFT below, UPI without an account", () => {
    expect(paymentMode(RTGS_MIN, true)).toBe("RTGS");
    expect(paymentMode(RTGS_MIN - 1, true)).toBe("NEFT");
    expect(paymentMode(500, false)).toBe("UPI");
  });
});

describe("form checks match the database's", () => {
  it("IFSC, account number, UPI", () => {
    expect(IFSC_RE.test(cleanIfsc(" hdfc0001234 "))).toBe(true);
    expect(IFSC_RE.test("HDFC1001234")).toBe(false); // 5th character must be 0
    expect(ACCOUNT_RE.test(cleanAccountNo("5020 0012-345678"))).toBe(true);
    expect(ACCOUNT_RE.test("12345")).toBe(false);
    expect(UPI_RE.test("ravi@okicici")).toBe(true);
    expect(UPI_RE.test("ravi@")).toBe(false);
  });
  it("masks an account number to its last four", () => {
    expect(maskAccount("50200012345678")).toBe("••••5678");
    expect(maskAccount(null)).toBe("—");
  });
});
