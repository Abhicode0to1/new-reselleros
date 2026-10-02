/**
 * The separate things a paid quote has to provision, one per product.
 *
 * 24 Sep 2026, enabling the site cart. One payment can buy a domain AND a hosting
 * account, and each needs its own activation: the domain registered, the account
 * created. The webhook used to pick ONE vendor per quote (hosting won), so a paid
 * domain in the same cart was queued for nobody.
 *
 * Domain lines name their domain (`line.domain`, set by the cart checkout since
 * the same date), so each named domain becomes its own request. Everything else
 * keeps the old single request, decided by `vendor` as before — a quote raised
 * in the app, with no named domain lines, is provisioned exactly as it was.
 *
 * Pure, so it can be tested without a webhook; the unique index
 * provisioning_requests_one_per_product (quote, vendor, domain) is what keeps a
 * re-delivered event from queuing any of these twice.
 */
import type { ProvisioningVendor } from "@/lib/provisioning/provisioning";

export interface ProvisioningProduct {
  vendor: ProvisioningVendor;
  domain: string | null;
  /** Seats for a licence; 1 for a domain or a hosting account. */
  seats: number;
  /**
   * Hosting only: this account's own plan label ("hosting-plus"), when the order has more
   * than one hosting plan. Without it every request carried the quote's one plan.
   */
  plan?: string;
}

/** A hosting plan line: it names the domain the account is set up ON, not one to buy. */
const isHostingLine = (l: unknown) =>
  !!l && typeof l === "object" && typeof (l as { hostingPlan?: unknown }).hostingPlan === "string";

/**
 * The exact domain names paid for, read from the quote's line items. Hosting lines are
 * skipped: since 1 Oct 2026 (R-032) a hosting line carries the domain its account is set up
 * on — usually the customer's own, which must never be queued for REGISTRATION.
 */
export function domainsInLines(lineItems: unknown): string[] {
  if (!Array.isArray(lineItems)) return [];
  const out: string[] = [];
  for (const l of lineItems) {
    if (isHostingLine(l)) continue;
    const d = l && typeof l === "object" ? (l as { domain?: unknown }).domain : undefined;
    if (typeof d === "string" && d.trim()) {
      const name = d.trim().toLowerCase();
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

export function provisioningProducts(input: {
  lineItems: unknown;
  /** The quote's vendor as the webhook resolves it (catalogue first, plan wording second). */
  vendor: ProvisioningVendor;
  /** The domain the payment notes name — the hosting account's domain. */
  domain: string | null;
  seats: number;
}): ProvisioningProduct[] {
  const named = domainsInLines(input.lineItems).map<ProvisioningProduct>((d) => ({
    vendor: "domain",
    domain: d,
    seats: 1,
  }));

  if (input.vendor === "domain") {
    // Domain-only order: the named domains ARE the products. With none named (a quote
    // raised in the app), fall back to the single request it always produced.
    return named.length ? named : [{ vendor: "domain", domain: input.domain, seats: 1 }];
  }

  /* Hosting: one request per hosting LINE, each on its own domain and plan (R-032,
     1 Oct 2026). Until then an order with Starter on a.in and Plus on b.in queued one
     request and only the first account was ever created. A line written before per-plan
     domains existed names none, and keeps the old single request below. */
  if (input.vendor === "hosting" && Array.isArray(input.lineItems)) {
    const accounts: ProvisioningProduct[] = [];
    for (const l of input.lineItems) {
      if (!isHostingLine(l)) continue;
      const line = l as { hostingPlan: string; hostingDomain?: unknown; domain?: unknown };
      const raw = typeof line.hostingDomain === "string" ? line.hostingDomain : typeof line.domain === "string" ? line.domain : "";
      const domain = raw.trim().toLowerCase();
      if (!domain || accounts.some((a) => a.domain === domain)) continue;
      accounts.push({ vendor: "hosting", domain, seats: 1, plan: `hosting-${line.hostingPlan.toLowerCase()}` });
    }
    if (accounts.length) return [...named, ...accounts];
  }

  const main: ProvisioningProduct = {
    vendor: input.vendor,
    domain: input.domain,
    seats: input.vendor === "hosting" ? 1 : Math.max(1, input.seats || 1),
  };
  return [...named, main];
}

/* ── R-033 (3 Oct 2026): each row's own share of the payment ─────────────────
   The engine's spend check (paid ≥ cost, coverFromPaid) read the row's amount_paid, and
   every row carried the WHOLE payment — so in a two-product order each product looked
   covered by both, and the check could not catch a domain that cost more than its line.
   Now each product gets the share of the payment its own lines are of the order's taxable
   value. A ₹0 domain bundled with yearly hosting takes its hosting line's share, as the
   bundle is what paid for it. No priced lines at all → the whole payment, as before. */
type Line = { rate?: unknown; qty?: unknown; discount_pct?: unknown; domain?: unknown; hostingPlan?: unknown; hostingDomain?: unknown };

const taxable = (l: Line) => {
  const rate = Number(l.rate) || 0, qty = Number(l.qty) || 0, disc = Number(l.discount_pct) || 0;
  return Math.max(0, rate * qty * (1 - Math.min(100, Math.max(0, disc)) / 100));
};
const lineDomain = (l: Line) => (typeof l.domain === "string" ? l.domain.trim().toLowerCase() : "");
const hostingDomainOf = (l: Line) =>
  (typeof l.hostingDomain === "string" ? l.hostingDomain : typeof l.domain === "string" ? l.domain : "").trim().toLowerCase();

/** 0..1 — the part of the order's taxable value this product's own lines account for. */
export function productShare(product: ProvisioningProduct, lineItems: unknown): number {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return 1;
  const lines = lineItems.filter((l) => l && typeof l === "object") as Line[];
  const total = lines.reduce((s, l) => s + taxable(l), 0);
  if (total <= 0) return 1;
  const hosting = lines.filter(isHostingLine);
  const want = (product.domain ?? "").trim().toLowerCase();
  let own = 0;
  if (product.vendor === "domain") {
    own = lines.filter((l) => !isHostingLine(l) && lineDomain(l) === want).reduce((s, l) => s + taxable(l), 0);
    if (own === 0) {
      // bundled free domain → the hosting line it came with (same domain, else the only one)
      const bundle = hosting.find((l) => hostingDomainOf(l) === want) ?? (hosting.length === 1 ? hosting[0] : undefined);
      own = bundle ? taxable(bundle) : 0;
    }
  } else if (product.vendor === "hosting") {
    const mine = hosting.filter((l) => hostingDomainOf(l) === want);
    own = (mine.length ? mine : hosting.length === 1 ? hosting : []).reduce((s, l) => s + taxable(l), 0);
    if (own === 0 && hosting.length === 0) own = total; // a hosting order written before hosting lines carried a plan
  } else {
    // a licence: every line that is neither a named domain nor a hosting account
    own = lines.filter((l) => !isHostingLine(l) && !lineDomain(l)).reduce((s, l) => s + taxable(l), 0);
    if (own === 0) own = total;
  }
  return Math.min(1, own / total);
}

/** This product's part of the payment, in rupees (GST included, like the payment). */
export function productAmountPaid(product: ProvisioningProduct, lineItems: unknown, paymentAmount: number): number {
  return Math.round(paymentAmount * productShare(product, lineItems));
}
