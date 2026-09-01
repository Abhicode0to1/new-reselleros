/**
 * CRM CSV builders — kacche integer ₹, headers-se-row ka milaan, aur null ka "".
 */
import { describe, it, expect } from "vitest";
import {
  CUSTOMERS_CSV_HEADERS, customersCsvRows,
  QUOTES_CSV_HEADERS, quotesCsvRows,
  INVOICES_CSV_HEADERS, invoicesCsvRows,
  PAYMENTS_CSV_HEADERS, paymentsCsvRows,
  SUBSCRIPTIONS_CSV_HEADERS, subscriptionsCsvRows,
  LEADS_CSV_HEADERS, leadsCsvRows,
} from "./crm-csv";

describe("crm-csv builders", () => {
  it("har builder ki row uske headers jitni chaudi hai", () => {
    const cust = customersCsvRows([{ name: "Acme", country: "India", since: "2026-01-01" } as never]);
    expect(cust[0].length).toBe(CUSTOMERS_CSV_HEADERS.length);

    const q = quotesCsvRows([{ id: "Q-1", customer_name: "Acme", subtotal: 1000, tax_rate: 18, amount: 1180 } as never]);
    expect(q[0].length).toBe(QUOTES_CSV_HEADERS.length);

    const inv = invoicesCsvRows([{ id: "INV-1", customer_name: "Acme", amount: 1180, invoice_date: "2026-08-01" } as never]);
    expect(inv[0].length).toBe(INVOICES_CSV_HEADERS.length);

    const pay = paymentsCsvRows([{ id: "p1", quote_id: "Q-1", amount: 1180, method: "upi", status: "received" } as never]);
    expect(pay[0].length).toBe(PAYMENTS_CSV_HEADERS.length);

    const sub = subscriptionsCsvRows([{ customer_name: "Acme", plan: "Starter", seats: 5, used: 3, mrr: 1350, status: "active" } as never]);
    expect(sub[0].length).toBe(SUBSCRIPTIONS_CSV_HEADERS.length);

    const lead = leadsCsvRows([{ company: "Acme", stage: "new" } as never]);
    expect(lead[0].length).toBe(LEADS_CSV_HEADERS.length);
  });

  it("amount kaccha integer hai, formatted string nahi; null → khaali", () => {
    const q = quotesCsvRows([{ id: "Q-1", customer_name: "Acme", subtotal: 305856, tax_rate: 18, amount: null, billing_cycle: null } as never])[0];
    expect(q).toContain(305856);
    expect(q.join("|")).not.toContain("₹");
    // amount null → "" (0 likhna jhooth hota — 0 aur "darj nahi" alag baatein hain)
    expect(q[QUOTES_CSV_HEADERS.indexOf("Total (₹)")]).toBe("");
  });
});
