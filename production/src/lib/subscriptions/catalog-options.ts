/**
 * Turning the `items` catalog into the choices the Add-subscription dialog offers.
 *
 * ─── WHY THE DIALOG'S OWN LIST HAD TO GO ────────────────────────────────────
 * add-subscription-dialog.tsx carried a hardcoded list of 29 products with their own
 * ids ("gw-starter") and their own prices. The ids matched nothing in the catalog
 * ("GW-STR-fbb"), so the dialog could not supply the subscription's item_id, and the
 * PRICES had drifted below the tenant's real vendor cost. Measured 14 Aug 2026,
 * ₹/seat/year:
 *
 *     product                        dialog   catalog     cost   margin at the
 *                                    default   (msrp)             dialog default
 *     GWS Business Starter            2,160    3,240      1,320    38.9%
 *     GWS Business Standard          10,080   10,368      7,440    26.2%
 *     GWS Business Plus              15,120   16,560     13,800     8.7%
 *     M365 Business Basic             1,800    2,400      1,980   −10.0%  LOSS
 *     M365 Business Standard          7,920   11,880      9,840   −24.2%  LOSS
 *     M365 Business Premium          18,000   22,800     19,440    −8.0%  LOSS
 *     Zoho Workplace Standard         1,188    1,440      1,140     4.0%
 *     Zoho Workplace Professional     2,388    3,360      2,640   −10.6%  LOSS
 *
 * Four of the eight overlapping products pre-filled a price BELOW what the vendor
 * charges. An operator who accepted the suggestion on M365 Business Standard lost
 * ₹1,920 per seat per year, and nothing on the screen said so. That is not a stale
 * default — it is a loss-making price offered by the app before a sale is even made.
 *
 * ─── THE UNIT, ESTABLISHED FROM THE DATA ────────────────────────────────────
 *     items.msrp                  ₹/seat/MONTH  — equals prices.annual.msrp on every
 *                                 row that has prices, and is the ONLY price on
 *                                 hosting/support rows, where prices is null
 *     items.prices.annual.wholesale  ₹/seat/MONTH cost
 * The dialog charges ₹/seat/YEAR, so both are × 12 here — once, in one place.
 */
import type { Item } from "@/lib/supabase/database.types";

export interface CatalogProduct {
  /** items.id — what gets stored in subscriptions.item_id. */
  id:     string;
  name:   string;
  vendor: Item["vendor"];
  /** ₹/seat/year the catalog says to charge. */
  annualSellPerSeat: number;
  /** ₹/seat/year the vendor charges. Null when no cost is recorded. */
  annualCostPerSeat: number | null;
}

/** ₹/seat/month sell. msrp is the annual-commitment monthly rate; prices.annual.msrp
 *  agrees with it wherever both exist, and hosting/support only have msrp. */
function monthlySell(it: Item): number {
  const p = (it.prices as { annual?: { msrp?: number } } | null)?.annual?.msrp;
  if (typeof p === "number" && p > 0) return p;
  return typeof it.msrp === "number" && it.msrp > 0 ? it.msrp : 0;
}

/** ₹/seat/month cost, or null. Zero is only meaningful with the vendor — see margin.ts. */
function monthlyCost(it: Item): number | null {
  const p = (it.prices as { annual?: { wholesale?: number } } | null)?.annual?.wholesale;
  if (typeof p === "number" && p > 0) return p;
  if (typeof it.wholesale === "number" && it.wholesale > 0) return it.wholesale;
  /* wholesale 0 is a real ₹0 for the reseller's own services and "not entered" for a
     resold vendor. Reporting null here rather than 0 keeps the dialog from showing a
     confident 100% margin on a row nobody has priced. */
  return it.wholesale === 0 ? 0 : null;
}

/**
 * Subscription products from the catalog, grouped by vendor, cheapest first.
 *
 * One-time items are excluded: they are not something a subscription renews. Inactive
 * items are the caller's business — useItems() already filters them.
 */
export function subscriptionProducts(items: readonly Item[]): CatalogProduct[] {
  return items
    .filter((it) => it.item_type !== "one_time")
    .map((it) => ({
      id:     it.id,
      name:   it.name,
      vendor: it.vendor,
      annualSellPerSeat: monthlySell(it) * 12,
      annualCostPerSeat: monthlyCost(it) === null ? null : monthlyCost(it)! * 12,
    }))
    .sort((a, b) =>
      a.vendor === b.vendor
        ? a.annualSellPerSeat - b.annualSellPerSeat
        : a.vendor.localeCompare(b.vendor));
}

/**
 * The vendors this tenant actually sells, in the catalog's order.
 *
 * Derived from the catalog rather than hardcoded, because the hardcoded list was four
 * values while the DB enum has seven — so `hosting` and `support` products, 7 of this
 * tenant's 17 subscription items, were unreachable from the dialog entirely.
 */
export function catalogVendors(products: readonly CatalogProduct[]): Item["vendor"][] {
  const seen: Item["vendor"][] = [];
  for (const p of products) if (!seen.includes(p.vendor)) seen.push(p.vendor);
  return seen;
}

export function productsForVendor(
  products: readonly CatalogProduct[], vendor: Item["vendor"],
): CatalogProduct[] {
  return products.filter((p) => p.vendor === vendor);
}

export function findProduct(
  products: readonly CatalogProduct[], id: string,
): CatalogProduct | undefined {
  return products.find((p) => p.id === id);
}

export type PriceVerdict =
  | { kind: "loss";    shortfallPerSeatYear: number }
  | { kind: "thin";    marginPct: number }
  | { kind: "ok";      marginPct: number }
  | { kind: "unknown" };

/**
 * Is the price the operator has typed actually profitable?
 *
 * Shown live, next to the field, because every loss-making default above was visible
 * on screen for months with nothing to mark it. A margin figure that only appears in a
 * report arrives after the quote has gone out.
 *
 * `thinBelowPct` is 10 to match THIN_MARGIN_BPS, and is just as much a placeholder.
 */
export function judgePrice(
  annualSellPerSeat: number,
  annualCostPerSeat: number | null,
  thinBelowPct = 10,
): PriceVerdict {
  if (annualCostPerSeat === null || annualSellPerSeat <= 0) return { kind: "unknown" };
  if (annualSellPerSeat < annualCostPerSeat) {
    return { kind: "loss", shortfallPerSeatYear: annualCostPerSeat - annualSellPerSeat };
  }
  const marginPct = ((annualSellPerSeat - annualCostPerSeat) / annualSellPerSeat) * 100;
  return marginPct < thinBelowPct ? { kind: "thin", marginPct } : { kind: "ok", marginPct };
}
