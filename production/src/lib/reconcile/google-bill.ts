/**
 * Google bill check (R-164, 5 Oct 2026) — the pure half.
 *
 * Anutech buys Google Workspace through Net2Secure (an authorised Google reseller): Google bills
 * Net2Secure every month per customer domain, and Net2Secure bills Anutech Google's price plus
 * ₹10 per user per year. Pardeep: "business me len den ki clearity rahe."
 *
 * Input: the text of Google's monthly invoice PDF (its "Summary of costs by domain" pages —
 * select all in the PDF and paste). Output, per domain: who the customer is in ResellerOS, what
 * Google charged, what we bill them (subscription MRR), and the gap. Plus the two lists that
 * matter most for money:
 *   • LEAKAGE — Google is charging for a domain we do not bill anybody for;
 *   • NOT ON THE BILL — we bill a customer whose domain Google did not charge (moved away?
 *     suspended? transferred to another reseller?).
 *
 * The PDF has no seat counts, so the Net2Secure margin is estimated from OUR seat counts; the
 * per-SKU check waits for Google's CSV. Everything here is read-only maths; nothing is saved.
 */

export interface BillLine { domain: string; customerId: string; amount: number }

export interface ParsedBill {
  invoiceNo: string | null;
  periodLabel: string | null;
  lines: BillLine[];
  subtotal: number | null;
  gst: number | null;
  total: number | null;
  /** Σ lines vs the printed subtotal — a paste that lost a page shows here. */
  linesTotal: number;
  /** Lines the parser could not read (shown, never dropped silently). */
  unread: string[];
}

const money = (s: string) => Number(s.replace(/[₹,\s]/g, ""));

/** "accesstel.in C04e9zwp8 529.20" — a domain, a Google customer id (C + 8 chars), a rupee amount. */
const LINE_RE = /^\s*([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\s+(C[0-9a-z]{6,12})\s+(-?[\d,]+\.\d{2})\s*$/i;

export function parseGoogleBill(text: string): ParsedBill {
  const lines: BillLine[] = [];
  const unread: string[] = [];
  const seen = new Set<string>();
  let subtotal: number | null = null, gst: number | null = null, total: number | null = null;
  const taxSeen = new Set<string>();
  const invoiceNo = text.match(/Invoice number:?\s*(\d{6,})/i)?.[1] ?? null;
  const period = text.match(/Summary (?:of costs by domain|for)\s*\n?\s*(\d{1,2} \w+ \d{4}\s*-\s*\d{1,2} \w+ \d{4})/i)?.[1] ?? null;

  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/ /g, " ").trim();
    if (!l) continue;
    const m = l.match(LINE_RE);
    if (m) {
      const key = `${m[1].toLowerCase()}|${m[2]}`;
      // The summary repeats on every page header only as column titles, but a paste of the
      // same page twice must not double a domain.
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push({ domain: m[1].toLowerCase(), customerId: m[2], amount: money(m[3]) });
      continue;
    }
    const st = l.match(/^Subtotal in INR\s*₹?\s*([\d,]+\.\d{2})/i);
    if (st) { subtotal = money(st[1]); continue; }
    const g = l.match(/^Integrated GST \(18%\)\s*₹?\s*([\d,]+\.\d{2})|^(?:CGST|SGST)[^₹\d]*₹?\s*([\d,]+\.\d{2})/i);
    /* First value of each tax line only: the invoice prints its summary on page 1 AND on the
       last page — summing doubled the IGST on the real Sept 2026 bill (₹2,02,359 for ₹1,01,179). */
    if (g) {
      const kind = /^Integrated/i.test(l) ? "igst" : /^CGST/i.test(l) ? "cgst" : "sgst";
      if (!taxSeen.has(kind)) { taxSeen.add(kind); gst = (gst ?? 0) + money(g[1] ?? g[2]); }
      continue;
    }
    const t = l.match(/^Total (?:amount due )?in INR\s*₹?\s*([\d,]+\.\d{2})/i);
    if (t) { total = money(t[1]); continue; }
    // A line that looks like a domain row but did not parse is worth showing.
    if (/^[a-z0-9.-]+\.[a-z]{2,}\s+C[0-9a-z]+/i.test(l)) unread.push(l);
  }
  /* A PDF copy puts labels and amounts on separate lines, in either order ("₹562,110.28 /
     ₹101,179.85 / ₹663,290.13 / Subtotal in INR / …"), so the labelled reads above often miss.
     Fallback: three consecutive rupee amounts where b ≈ 18% of a and c = a + b ARE subtotal,
     IGST and total — the maths identifies them, whatever the layout. */
  if (subtotal === null || gst === null || total === null) {
    const amts = [...text.matchAll(/₹\s?([\d,]+\.\d{2})/g)].map((x) => money(x[1]));
    for (let i = 0; i + 2 < amts.length; i++) {
      const [x, y, z] = [amts[i], amts[i + 1], amts[i + 2]];
      if (x > 0 && Math.abs(y - x * 0.18) <= 1 && Math.abs(z - (x + y)) <= 0.05) { subtotal = x; gst = y; total = z; break; }
    }
  }
  const linesTotal = Math.round(lines.reduce((a, x) => a + x.amount, 0) * 100) / 100;
  return { invoiceNo, periodLabel: period, lines, subtotal, gst, total, linesTotal, unread };
}

// ─── Matching ────────────────────────────────────────────────────────────────

export interface SubLite {
  id: string;
  customer_id: string | null;
  customer_name: string;
  domain: string | null;
  vendor: string;
  status: string;
  seats: number;
  vendor_seats: number | null;
  mrr: number;
  plan: string;
}
export interface CustomerLite { id: string; name: string; domain: string | null }

export const normDomain = (s: string | null | undefined) =>
  (s || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

export type RowStatus = "ok" | "loss" | "no_subscription" | "no_customer";

export interface CheckRow {
  domain: string;
  customerId: string;
  googleCost: number;
  customerName: string | null;
  customerRef: string | null;
  /** What we bill this domain per month (active Google subscriptions' MRR). */
  ourMonthly: number;
  seats: number;
  plans: string[];
  margin: number;
  status: RowStatus;
}

/** sub_status is active | paused | expired | cancelled. Paused stays in: Google may still bill a suspended account. */
const ACTIVE = new Set(["active", "paused"]);
const isGoogle = (v: string) => v === "google";

export interface BillCheck {
  rows: CheckRow[];
  /** Our active Google subscriptions whose domain is not on this bill. */
  notOnBill: { domain: string; customerName: string; ourMonthly: number; seats: number }[];
  totals: {
    googleCost: number;
    ourMonthly: number;
    margin: number;
    leakage: number;          // Google cost on domains with no customer / no subscription
    leakageCount: number;
    lossCount: number;        // matched but we bill less than Google charges
    seats: number;
  };
}

export function checkBill(lines: readonly BillLine[], subs: readonly SubLite[], customers: readonly CustomerLite[]): BillCheck {
  const googleSubs = subs.filter((s) => isGoogle(s.vendor) && ACTIVE.has(s.status) && s.domain);
  const subsByDomain = new Map<string, SubLite[]>();
  for (const s of googleSubs) {
    const d = normDomain(s.domain);
    subsByDomain.set(d, [...(subsByDomain.get(d) ?? []), s]);
  }
  const custByDomain = new Map(customers.filter((c) => c.domain).map((c) => [normDomain(c.domain), c]));

  const rows: CheckRow[] = lines.map((l) => {
    const ss = subsByDomain.get(l.domain) ?? [];
    const cust = custByDomain.get(l.domain) ?? null;
    const ourMonthly = ss.reduce((a, s) => a + Number(s.mrr || 0), 0);
    const seats = ss.reduce((a, s) => a + Number(s.vendor_seats ?? s.seats ?? 0), 0);
    const margin = Math.round((ourMonthly - l.amount) * 100) / 100;
    const status: RowStatus = !ss.length && !cust ? "no_customer" : !ss.length ? "no_subscription" : margin < 0 ? "loss" : "ok";
    return {
      domain: l.domain, customerId: l.customerId, googleCost: l.amount,
      customerName: ss[0]?.customer_name ?? cust?.name ?? null,
      customerRef: ss[0]?.customer_id ?? cust?.id ?? null,
      ourMonthly, seats, plans: [...new Set(ss.map((s) => s.plan))], margin, status,
    };
  });

  const billed = new Set(lines.map((l) => l.domain));
  const notOnBill = [...subsByDomain.entries()]
    .filter(([d]) => !billed.has(d))
    .map(([d, ss]) => ({ domain: d, customerName: ss[0].customer_name, ourMonthly: ss.reduce((a, s) => a + Number(s.mrr || 0), 0), seats: ss.reduce((a, s) => a + Number(s.seats || 0), 0) }))
    .sort((a, b) => b.ourMonthly - a.ourMonthly);

  const leak = rows.filter((r) => r.status === "no_customer" || r.status === "no_subscription");
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    rows: rows.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.googleCost - a.googleCost),
    notOnBill,
    totals: {
      googleCost: r2(rows.reduce((a, r) => a + r.googleCost, 0)),
      ourMonthly: r2(rows.reduce((a, r) => a + r.ourMonthly, 0)),
      margin: r2(rows.reduce((a, r) => a + r.margin, 0)),
      leakage: r2(leak.reduce((a, r) => a + r.googleCost, 0)),
      leakageCount: leak.length,
      lossCount: rows.filter((r) => r.status === "loss").length,
      seats: rows.reduce((a, r) => a + r.seats, 0),
    },
  };
}

const STATUS_RANK: Record<RowStatus, number> = { no_customer: 0, no_subscription: 1, loss: 2, ok: 3 };

/**
 * What Net2Secure should bill for this month: Google's subtotal + ₹`perSeatYear` per seat per
 * year, spread monthly. Seats are OUR counts (the PDF has none), so this is an estimate until
 * the CSV arrives — the page says so.
 */
export function expectedPartnerBill(googleSubtotal: number, seats: number, perSeatYear = 10): { margin: number; expected: number } {
  const margin = Math.round(((seats * perSeatYear) / 12) * 100) / 100;
  return { margin, expected: Math.round((googleSubtotal + margin) * 100) / 100 };
}
