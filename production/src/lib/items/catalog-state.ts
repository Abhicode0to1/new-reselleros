/**
 * Does this tenant have a product catalog yet? (2 Oct 2026)
 *
 * Every tenant is seeded six support tiers (20260817160000_support_tier_skus.sql). They are
 * add-ons sold WITH a product, not products. Counting them made a brand-new tenant's catalog
 * look loaded: /items hid "Load default catalog" (it showed only on an empty list) and /setup
 * said "Loaded" — so the one button that fills Google Workspace / M365 / Zoho was unreachable.
 */
export function productCount(items: readonly { vendor: string }[] | null | undefined): number {
  return (items ?? []).filter((i) => i.vendor !== "support").length;
}
