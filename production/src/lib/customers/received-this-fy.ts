/**
 * Money actually received from each customer in the current financial year (R-005).
 *
 * The Customers list had Monthly / To collect / Unused credits and nothing for money
 * RECEIVED, so a customer who had paid ₹11,80,000 for a project read ₹0 everywhere.
 *
 * Sum per customer, dated inside the FY (IST, April → March):
 *   · payments          status 'received' (customer_id, else the quote's customer)
 *   · project_payments  every method, INCLUDING 'tds' — TDS the customer deducted and paid
 *                       to the government on our behalf settles the invoice like cash does;
 *                       it is reported separately so the tooltip can say "of which TDS ₹…".
 */
import { toIstDate } from "@/lib/dates/ist";

export interface ReceivedFacts { total: number; tds: number }

export function receivedThisFy(src: {
  payments: readonly { customer_id: string | null; quote_id?: string | null; amount: number | null; status: string | null; received_at: string | null }[];
  quoteCustomer?: ReadonlyMap<string, string | null>;
  projectPayments: readonly { project_id: string; amount: number | null; method: string | null; received_at: string | null }[];
  projectCustomer: ReadonlyMap<string, string | null>;
  fy: { start: string; end: string };
}): Record<string, ReceivedFacts> {
  const out: Record<string, ReceivedFacts> = {};
  const inFy = (at: string | null) => {
    if (!at) return false;
    const d = at.length > 10 ? toIstDate(at) : at;
    return d >= src.fy.start && d <= src.fy.end;
  };
  const add = (cust: string | null | undefined, amt: number, tds: number) => {
    if (!cust || !(amt > 0)) return;
    const r = (out[cust] ??= { total: 0, tds: 0 });
    r.total += amt;
    r.tds += tds;
  };

  for (const p of src.payments) {
    if (p.status !== "received" || !inFy(p.received_at)) continue;
    const cust = p.customer_id ?? (p.quote_id ? src.quoteCustomer?.get(p.quote_id) ?? null : null);
    add(cust, Math.round(p.amount ?? 0), 0);
  }
  for (const p of src.projectPayments) {
    if (!inFy(p.received_at)) continue;
    const amt = Math.round(p.amount ?? 0);
    add(src.projectCustomer.get(p.project_id), amt, p.method === "tds" ? amt : 0);
  }
  return out;
}
