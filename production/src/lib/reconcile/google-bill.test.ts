/**
 * R-164 — Google bill check. The text below is the shape a select-all copy of Google's invoice
 * PDF gives (Invoice 5702996051, Sept 2026): amounts and labels on separate lines.
 */
import { describe, it, expect } from "vitest";
import { parseGoogleBill, checkBill, expectedPartnerBill, normDomain, type SubLite, type CustomerLite } from "./google-bill";

const PDF_TEXT = `For questions about this invoice please email collections@google.com Page 1 of 7
Invoice
Invoice number: 5702996051
₹1,020.00
₹183.60
₹1,203.60
Summary for 1 Sept 2026 - 30 Sept 2026
Pay in INR:
Subtotal in INR
Integrated GST (18%)
Total amount due in INR
Summary of costs by domain
1 Sept 2026 - 30 Sept 2026
Domain name Customer ID Amount(₹)
accesstel.in C04e9zwp8 529.20
adclues.com C00nlpovy 229.32
hindustanayinda.com C01crmkqv 8.82
Invoice Invoice number: 5702996051
Domain name Customer ID Amount(₹)
ipcapitalcorp.co.uk C00qu36m5 49.00
ai.tattvaspa.org C01o0rdg5 203.66
murli-terracotta.com C02kkljwy 0.00
`;

describe("parseGoogleBill", () => {
  const b = parseGoogleBill(PDF_TEXT);
  it("reads every domain line, multi-part TLDs and hyphens included", () => {
    expect(b.lines.map((l) => l.domain)).toEqual([
      "accesstel.in", "adclues.com", "hindustanayinda.com", "ipcapitalcorp.co.uk", "ai.tattvaspa.org", "murli-terracotta.com",
    ]);
    expect(b.lines[0]).toEqual({ domain: "accesstel.in", customerId: "C04e9zwp8", amount: 529.2 });
  });
  it("finds subtotal / GST / total by their maths when labels sit on other lines", () => {
    expect([b.subtotal, b.gst, b.total]).toEqual([1020, 183.6, 1203.6]);
    expect(b.linesTotal).toBe(1020);
    expect(b.invoiceNo).toBe("5702996051");
    expect(b.periodLabel).toBe("1 Sept 2026 - 30 Sept 2026");
  });
  it("takes the tax once when the summary is printed on two pages (real Sept 2026 bill)", () => {
    const t = ["Subtotal in INR ₹ 562,110.28", "Integrated GST (18%) ₹ 101,179.85", "Total amount due in INR ₹ 663,290.13", "Subtotal in INR ₹ 562,110.28", "Integrated GST (18%) ₹ 101,179.85", "Total in INR ₹ 663,290.13"].join(String.fromCharCode(10));
    const x = parseGoogleBill(t);
    expect([x.subtotal, x.gst, x.total]).toEqual([562110.28, 101179.85, 663290.13]);
  });
  it("does not double a page pasted twice", () => {
    expect(parseGoogleBill(PDF_TEXT + PDF_TEXT).lines).toHaveLength(6);
  });
  it("reports a domain-looking line it could not read instead of dropping it", () => {
    expect(parseGoogleBill("broken.in C01abcdef 12,3").unread).toEqual(["broken.in C01abcdef 12,3"]);
  });
});

const sub = (over: Partial<SubLite>): SubLite => ({
  id: "s1", customer_id: "c1", customer_name: "Accesstel", domain: "accesstel.in", vendor: "google",
  status: "active", seats: 3, vendor_seats: null, mrr: 750, plan: "Business Starter", ...over,
});

describe("checkBill", () => {
  const lines = parseGoogleBill(PDF_TEXT).lines;
  const subs: SubLite[] = [
    sub({}),
    sub({ id: "s2", customer_id: "c2", customer_name: "Adclues", domain: "www.AdClues.com", mrr: 200, seats: 1 }),        // billed below cost
    sub({ id: "s3", customer_id: "c3", customer_name: "Old Client", domain: "gone-away.in", mrr: 900, seats: 4 }),       // not on Google's bill
    sub({ id: "s4", customer_id: "c4", customer_name: "Cancelled Co", domain: "ipcapitalcorp.co.uk", status: "cancelled" }),
    sub({ id: "s5", customer_id: "c5", customer_name: "M365 Co", domain: "hindustanayinda.com", vendor: "microsoft" }),
  ];
  const customers: CustomerLite[] = [{ id: "c6", name: "Tattva Spa", domain: "ai.tattvaspa.org" }];
  const r = checkBill(lines, subs, customers);
  const by = (d: string) => r.rows.find((x) => x.domain === d)!;

  it("matches by domain, ignoring case and www", () => {
    expect(by("accesstel.in")).toMatchObject({ status: "ok", customerName: "Accesstel", ourMonthly: 750, margin: 220.8, seats: 3 });
    expect(by("adclues.com")).toMatchObject({ status: "loss", margin: -29.32 });
  });
  it("calls out leakage: no customer at all, or a customer with no live Google subscription", () => {
    expect(by("murli-terracotta.com").status).toBe("no_customer");
    expect(by("ipcapitalcorp.co.uk").status).toBe("no_customer"); // its only sub is cancelled
    expect(by("hindustanayinda.com").status).toBe("no_customer"); // a Microsoft sub is not a Google one
    expect(by("ai.tattvaspa.org")).toMatchObject({ status: "no_subscription", customerName: "Tattva Spa" });
    expect(r.totals.leakageCount).toBe(4);
    expect(r.totals.leakage).toBe(261.48);
  });
  it("lists what we bill that Google did not charge", () => {
    expect(r.notOnBill).toEqual([{ domain: "gone-away.in", customerName: "Old Client", ourMonthly: 900, seats: 4 }]);
  });
  it("puts the money problems first", () => {
    expect(r.rows.map((x) => x.status)).toEqual(["no_customer", "no_customer", "no_customer", "no_subscription", "loss", "ok"]);
    expect(r.rows.slice(0, 3).map((x) => x.domain)).toEqual(["ipcapitalcorp.co.uk", "hindustanayinda.com", "murli-terracotta.com"]); // biggest leak first
    expect(r.rows.at(-1)!.status).toBe("ok");
  });
});

describe("Net2Secure margin", () => {
  it("is ₹10 per seat per year, spread monthly, on top of Google's subtotal", () => {
    expect(expectedPartnerBill(562110.28, 1200)).toEqual({ margin: 1000, expected: 563110.28 });
    expect(expectedPartnerBill(1000, 7, 10).margin).toBe(5.83);
  });
  it("normalises domains", () => {
    expect(normDomain(" https://www.Example.co.in/path ")).toBe("example.co.in");
  });
});
