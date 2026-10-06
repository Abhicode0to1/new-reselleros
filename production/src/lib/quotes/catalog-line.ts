/**
 * A catalogue row → a ₹ quote line, the one way every adder prices it (2 Oct 2026).
 *
 * The Add-item dialog, the lead's one-tap product chips and the "+ Support" toggle all add
 * catalogue items; three copies of this arithmetic is how the yearly support plan came to be
 * a ₹0 line in one of them. Storage is ₹/seat/YEAR (QuoteLineItem.rate), commitment annual.
 *
 *  - prices.annual_total → a whole-year total, used verbatim (yearly-discount plans)
 *  - else the annual tier, then the monthly tier, then msrp — all ₹/month — × 12
 *
 * Foreign-currency pricing stays in the dialog; this is the ₹ path.
 */
import { catalogDefaultQty } from "@/lib/quotes/line-items";
import type { Item, QuoteLineItem } from "@/lib/supabase/database.types";

type PriceTier = { msrp?: number; wholesale?: number } | undefined;

export function catalogYearlyPrice(it: Pick<Item, "msrp" | "wholesale" | "prices">): { rate: number; cost: number } {
  const prices = (it.prices ?? null) as { annual_total?: PriceTier; annual?: PriceTier; monthly?: PriceTier } | null;
  const total = prices?.annual_total;
  if (total && typeof total.msrp === "number" && total.msrp > 0 && !(it.msrp > 0)) {
    return { rate: total.msrp, cost: total.wholesale ?? 0 };
  }
  const msrpPerMo      = prices?.annual?.msrp      ?? prices?.monthly?.msrp      ?? it.msrp;
  const wholesalePerMo = prices?.annual?.wholesale ?? prices?.monthly?.wholesale ?? it.wholesale;
  return { rate: msrpPerMo * 12, cost: (wholesalePerMo ?? 0) * 12 };
}

export function lineFromCatalog(
  it: Pick<Item, "id" | "name" | "vendor" | "msrp" | "wholesale" | "prices">,
  opts: { qty?: number } = {},
): QuoteLineItem {
  const { rate, cost } = catalogYearlyPrice(it);
  return {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `line-${Date.now()}`,
    item_id: it.id,
    name: it.name,
    qty: opts.qty && opts.qty > 0 ? opts.qty : catalogDefaultQty(it.vendor),
    rate,
    cost,
    commitment: "annual_yearly",
  };
}
