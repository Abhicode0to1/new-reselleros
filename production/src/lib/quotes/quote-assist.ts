/**
 * Small, pure helpers behind the quote builder's shortcuts (2 Oct 2026, Pardeep:
 * "is page ko aur improve nahi kiya ja sakta").
 *
 *  - suggestPlanProducts: the lead says "Google Workspace" but the quote opened empty, so
 *    the rep had to hunt the catalogue. These are the one-tap product chips.
 *  - productSupportSku:   the product-wise support add-on for a licence line
 *    ("Google Workspace Business Starter Support"), see migration 20261002160000.
 *  - supplyStateMissing:  with no place of supply the quote silently assumed CGST+SGST;
 *    a send must stop and ask instead.
 */

export interface AssistItem {
  id: string;
  name: string;
  vendor: string;
  kind?: string | null;
  item_type?: string | null;
  is_active?: boolean | null;
  msrp: number;
}

type ProductVendor = "google" | "microsoft" | "zoho";

/** Which vendor a lead's free-text interest names. Null = it does not say. */
export function vendorFromPlanText(plan: string | null | undefined): ProductVendor | null {
  const p = (plan ?? "").toLowerCase();
  if (!p) return null;
  if (/google|workspace|g ?suite|gws/.test(p)) return "google";
  if (/microsoft|m365|office|365|outlook|exchange/.test(p)) return "microsoft";
  if (/zoho/.test(p)) return "zoho";
  return null;
}

/**
 * Main licence products to offer as chips, cheapest first. A lead naming a vendor gets
 * that vendor's products only; a lead naming none gets Google's (the bulk of the
 * business) so the empty state still has something to tap.
 */
export function suggestPlanProducts<T extends AssistItem>(
  catalog: readonly T[] | null | undefined,
  leadPlan: string | null | undefined,
  limit = 4,
): T[] {
  const vendor = vendorFromPlanText(leadPlan) ?? "google";
  return (catalog ?? [])
    .filter((i) => i.vendor === vendor && i.kind === "main" && i.is_active !== false && i.item_type !== "one_time")
    .sort((a, b) => a.msrp - b.msrp)
    .slice(0, limit);
}

/** The product-wise support add-on for a licence line, if the catalogue has one. */
export function productSupportSku<T extends { id: string }>(
  catalog: readonly T[] | null | undefined,
  productItemId: string | null | undefined,
  cycle: "monthly" | "yearly",
): T | undefined {
  if (!productItemId) return undefined;
  const id = `SUP-${productItemId}-${cycle === "yearly" ? "YR" : "MO"}`;
  return (catalog ?? []).find((i) => i.id === id);
}

/** A domestic quote with no buyer state cannot know CGST+SGST from IGST. */
export function supplyStateMissing(opts: { isExport: boolean; buyerStateCode: string | null | undefined }): boolean {
  return !opts.isExport && !(opts.buyerStateCode ?? "").trim();
}
