/**
 * The portable subscription file — one CSV that can be read back.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * Export and Import were not a pair. Export wrote a REPORT ("Customer", "Plan", "Seats")
 * and Import expected a Zoho Billing migration file ("Customer Number", "Item Name",
 * "Quantity"), so re-importing an export skipped every row. Worse, the two were built on
 * different assumptions about what the file was FOR.
 *
 * Abhishek settled it on 23 Sep 2026: the file should be portable. Enough to restore into
 * this app, enough to hand to a different app, and readable in Excel — carrying the
 * customer and the contact, not just the subscription. That is a backup format, and it is
 * a far better job for those two buttons than a migration out of a product he never used
 * (Zoho BOOKS holds invoices; Zoho BILLING holds subscriptions, and the importer had
 * never once been run).
 *
 * ─── THE MONEY COLUMN IS THE WHOLE DESIGN ───────────────────────────────────
 * The old importer derived the monthly rate:
 *
 *     months = (End − Start) / 30.44        // and 12 when either date was missing
 *     MRR    = (Item Price × Quantity) / months
 *
 * That division is where this codebase has been burnt twice — a per-month rate read as
 * per-year and the reverse, each time off by twelve, each time producing a number that
 * looked entirely normal. The missing-dates branch is the worst of it: a monthly
 * subscription with no dates silently became a twelfth of itself.
 *
 * So the portable file writes **MRR (₹/month)** directly and the reader PREFERS it. A
 * round trip does no arithmetic at all, which is the only way to guarantee the number
 * that comes back is the number that went out. `Item Price` is still written, for other
 * apps and for humans, and still read — but only when the monthly column is absent.
 *
 * ─── AND IT REFUSES RATHER THAN GUESSING ────────────────────────────────────
 * When neither a monthly rate nor a derivable period is present, `monthlyRateFrom`
 * returns null with a reason. It never falls back to "assume a year". That fallback is
 * exactly the one that produced the twelve-times bug, and a plausible wrong price on a
 * restored subscription is worse than a row the operator has to look at.
 */
/** What downloadCSV accepts in a cell. Same shape as crm-csv.ts uses. */
type Cell = string | number;

/* ── The columns ───────────────────────────────────────────────────────────────
   Named for a human first. Aliases in `HEADER_ALIASES` let the reader accept the old
   export's names and a Zoho Billing file, so nothing that used to work stops working. */
export const PORTABLE_SUBSCRIPTION_HEADERS = [
  // Who
  "Customer Number", "Customer", "Domain", "GSTIN", "State",
  // Who to talk to — carried so an import can CREATE the customer, which this app
  // refuses to do without a contact person.
  "Contact Name", "Contact Email", "Contact Phone",
  // What they bought
  "Plan", "Vendor", "Seats", "Status",
  // The money. MRR is authoritative; Item Price is for other systems and for reading.
  "MRR (₹/month)", "Item Price", "Outstanding (₹)",
  // When
  "Start Date", "End Date",
  // What the vendor says — kept so a restore does not lose the reconciliation.
  "Vendor Seats",
] as const;

export interface PortableSubscriptionInput {
  customer_number?: string | null;
  customer_name?: string | null;
  domain?: string | null;
  gstin?: string | null;
  state?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  plan?: string | null;
  vendor?: string | null;
  seats?: number | null;
  status?: string | null;
  mrr?: number | null;
  outstanding_amount?: number | null;
  start_date?: string | null;
  renewal_date?: string | null;
  vendor_seats?: number | null;
}

/** One row, in the order of PORTABLE_SUBSCRIPTION_HEADERS. */
export function portableSubscriptionRow(x: PortableSubscriptionInput): Cell[] {
  const seats = x.seats ?? 0;
  const mrr = x.mrr ?? 0;
  return [
    s(x.customer_number), s(x.customer_name), s(x.domain), s(x.gstin), s(x.state),
    s(x.contact_name), s(x.contact_email), s(x.contact_phone),
    s(x.plan), s(x.vendor), s(seats), s(x.status),
    s(mrr),
    /* Per seat per MONTH, matching what MRR means — NOT a period total. A reader that
       falls back to this column multiplies by seats and divides by the period, so a
       yearly figure here would come back twelve times too big. */
    s(seats > 0 ? Math.round(mrr / seats) : 0),
    s(x.outstanding_amount ?? 0),
    s(x.start_date), s(x.renewal_date),
    /* Blank, not 0, when the vendor was never asked — 0 would restore as "Google bills
       us for nothing", which reads as a matched subscription. */
    x.vendor_seats == null ? "" : s(x.vendor_seats),
  ];
}

/* ── Reading one back ───────────────────────────────────────────────────────── */

/**
 * Header spellings accepted for each field, lower-cased.
 *
 * The portable name comes first, then the old export's, then Zoho Billing's. Order is
 * the precedence: a file carrying both "mrr (₹/month)" and "item price" uses the monthly
 * one, which is the entire point of the format.
 */
export const HEADER_ALIASES: Record<string, string[]> = {
  customerNumber: ["customer number", "customer_number", "customer no"],
  customerName:   ["customer", "customer name", "company", "company name"],
  domain:         ["domain", "domain name", "domain_name"],
  gstin:          ["gstin", "gst number", "gst no"],
  state:          ["state", "place of supply"],
  contactName:    ["contact name", "contact_name", "contact person"],
  contactEmail:   ["contact email", "contact_email", "email"],
  contactPhone:   ["contact phone", "contact_phone", "phone", "mobile"],
  plan:           ["plan", "item name", "item_name", "product", "plan name"],
  vendor:         ["vendor"],
  seats:          ["seats", "quantity", "qty"],
  status:         ["status"],
  monthly:        ["mrr (₹/month)", "mrr (rs/month)", "mrr", "mrr (₹)", "monthly rate"],
  itemPrice:      ["item price", "item_price", "price", "rate", "selling price"],
  outstanding:    ["outstanding (₹)", "outstanding", "balance"],
  start:          ["start date", "start_date", "start"],
  end:            ["end date", "end_date", "end", "renewal date", "renewal", "expiry date"],
  vendorSeats:    ["vendor seats", "vendor_seats", "purchased licenses"],
};

/** Column index per field, or -1. `header` must already be lower-cased and trimmed. */
export function mapHeader(header: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    out[field] = -1;
    for (const alias of aliases) {
      const i = header.indexOf(alias);
      if (i >= 0) { out[field] = i; break; }
    }
  }
  return out;
}

export type MonthlyRate =
  | { ok: true; mrr: number; from: "monthly" | "period" }
  | { ok: false; reason: string };

/**
 * The ₹/month for a row — read directly when the file says so, derived only when it must.
 *
 * @param monthly    the "MRR (₹/month)" cell, if the file had one
 * @param itemPrice  the per-period-per-seat cell
 * @param seats      quantity
 * @param months     period length, or null when the dates could not give one
 */
export function monthlyRateFrom(
  monthly: number | null, itemPrice: number | null, seats: number, months: number | null,
): MonthlyRate {
  /* Preferred, and the reason the format exists: no arithmetic, so a round trip cannot
     change the number. A zero is a real answer here (a free or bundled subscription), so
     it is accepted — only a missing column falls through. */
  if (monthly != null && Number.isFinite(monthly) && monthly >= 0) {
    return { ok: true, mrr: Math.round(monthly), from: "monthly" };
  }
  if (itemPrice == null || !Number.isFinite(itemPrice)) {
    return { ok: false, reason: "no monthly rate and no price in the file" };
  }
  if (seats <= 0) {
    return { ok: false, reason: "no seat count, so a per-seat price cannot be totalled" };
  }
  if (months == null || months <= 0) {
    /* THE REFUSAL THAT MATTERS. The old importer assumed 12 here, which turned a monthly
       subscription into a twelfth of itself — silently, and the result looked normal. */
    return {
      ok: false,
      reason: "the price covers a period the dates do not give — add Start Date and End Date, or an MRR (₹/month) column",
    };
  }
  return { ok: true, mrr: Math.round((itemPrice * seats) / months), from: "period" };
}

/** Whole months between two ISO dates, or null when either is unusable. */
export function periodMonths(startISO: string | null, endISO: string | null): number | null {
  if (!startISO || !endISO) return null;
  const a = Date.parse(startISO);
  const b = Date.parse(endISO);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return null;
  /* 30.44 = 365.25/12. A 1-month term lands on 1, a 12-month term on 12, and a 2-year
     term on 24 — checked in the tests rather than assumed. */
  return Math.max(1, Math.round((b - a) / 86400000 / 30.44));
}

function s(v: unknown): Cell {
  return v == null ? "" : String(v);
}
