/**
 * Shape a catalogue row for PUBLIC consumption — the company website reads this.
 *
 * ─── THE ONE RULE ───────────────────────────────────────────────────────────
 * `wholesale` and `margin_pct` must never leave this function. They are the business's
 * buy price and its margin — on a public endpoint they would hand every customer the
 * negotiation floor, and every competitor the cost structure. That is why this is a
 * FUNCTION with a test, not a `select` list someone widens in a hurry: the test feeds a
 * row that CONTAINS wholesale figures and asserts the output carries none of them, and
 * it walks the output recursively so a nested `prices.annual.wholesale` cannot slip
 * through either.
 *
 * What the website needs, and all it gets:
 *   name              "Google Workspace Business Starter"
 *   annualPerSeatMo   ₹/seat/month on the annual commitment  (items.msrp — see §13:
 *                     money is whole rupees, and msrp is per seat per MONTH)
 *   monthlyPerSeatMo  ₹/seat/month on the flexible tier      (prices.monthly.msrp)
 *
 * The flex figure can be null — a product priced only for annual commitment simply has
 * no monthly tier, and the website must show "annual only" rather than invent a number.
 */

export interface PublicWorkspaceItem {
  name: string;
  annualPerSeatMo: number;
  monthlyPerSeatMo: number | null;
}

interface CatalogRowLike {
  name: string | null;
  msrp: number | null;
  prices: unknown;
}

function monthlyMsrp(prices: unknown): number | null {
  if (!prices || typeof prices !== "object") return null;
  const monthly = (prices as Record<string, unknown>).monthly;
  if (!monthly || typeof monthly !== "object") return null;
  const msrp = (monthly as Record<string, unknown>).msrp;
  return typeof msrp === "number" && Number.isFinite(msrp) && msrp > 0 ? msrp : null;
}

export function publicWorkspaceCatalog(rows: readonly CatalogRowLike[]): PublicWorkspaceItem[] {
  const out: PublicWorkspaceItem[] = [];
  for (const r of rows) {
    /* A row with no name or no positive customer price is not publishable — skipped, not
       nulled, so the website never renders a card it cannot price. */
    if (!r.name?.trim()) continue;
    if (typeof r.msrp !== "number" || !Number.isFinite(r.msrp) || r.msrp <= 0) continue;
    out.push({
      name: r.name.trim(),
      annualPerSeatMo: r.msrp,
      monthlyPerSeatMo: monthlyMsrp(r.prices),
    });
  }
  return out;
}
