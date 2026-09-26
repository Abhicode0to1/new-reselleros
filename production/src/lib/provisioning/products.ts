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
}

/** The exact domain names paid for, read from the quote's line items. */
export function domainsInLines(lineItems: unknown): string[] {
  if (!Array.isArray(lineItems)) return [];
  const out: string[] = [];
  for (const l of lineItems) {
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

  const main: ProvisioningProduct = {
    vendor: input.vendor,
    domain: input.domain,
    seats: input.vendor === "hosting" ? 1 : Math.max(1, input.seats || 1),
  };
  return [...named, main];
}
