/**
 * Which TLDs may go into the domain rate card, and which must not.
 *
 * ─── THE CARD IS ANNUAL, AND NOTHING SAYS SO ────────────────────────────────
 * `sync_domain_catalog` writes one `items` row per priced TLD carrying
 * `prices.register`, `prices.renew` and `prices.transfer`, and everything
 * downstream reads those as ONE YEAR. `lib/domains/renewal-pricing.ts` prices a
 * renewal straight from `prices.renew` — its header is explicit that the number
 * is "a DIFFERENT number from the registration price and usually higher", but
 * nowhere does it, or the rows, carry a TERM.
 *
 * That was safe while every price in the payload was annual. It stopped being
 * safe on 17 Sep 2026, when `rcTldPricing` started reporting the shortest term a
 * registrar actually sells instead of silently nulling anything without a 1-year
 * key. ResellerClub has exactly one such product on this account — `.ai`, sold
 * in a 2-YEAR MINIMUM at ₹8,806.80 register and ₹9,346.80 renew.
 *
 * Sync that row and the card says a `.ai` renewal costs ₹9,347 for a year. It
 * does not; that is two years. The customer is quoted it, pays it, and the
 * renewal is filed for a term nobody agreed. Nothing would flag it — the number
 * is real, it is just an answer to a different question.
 *
 * `.ai` is not in the route's TLD list today, so this is a guard against a
 * one-word change, not a live defect. That is exactly when it is cheap to add.
 *
 * ─── AND IT SAYS WHAT IT SKIPPED ────────────────────────────────────────────
 * Silently dropping a TLD is its own trap: an operator adds `.ai` to the list,
 * presses Sync domains, sees "synced 8", and concludes it worked. So the skip
 * carries a reason and the route reports it.
 */

export interface TldPriceRow {
  tld: string;
  register: number | null;
  renew: number | null;
  transfer: number | null;
  currency: string;
  /**
   * The term those amounts buy, in years.
   *
   * Optional because the engine's public API (the fallback path, used whenever
   * ResellerClub credentials are absent) has only ever quoted annually and sends
   * no such field. Absent therefore means 1 — the historical contract — rather
   * than "unknown", which would reject every row on the fallback path.
   */
  years?: number;
}

export interface TldSyncPlan {
  sync: TldPriceRow[];
  skipped: { tld: string; reason: string }[];
}

/** Split a rate card into what the catalogue may hold and what it may not. */
export function syncableTlds(rows: readonly TldPriceRow[]): TldSyncPlan {
  const sync: TldPriceRow[] = [];
  const skipped: { tld: string; reason: string }[] = [];

  for (const row of rows) {
    if (typeof row.register !== "number" || row.register <= 0) {
      skipped.push({ tld: row.tld, reason: "the registrar gave no registration price" });
      continue;
    }
    const years = row.years ?? 1;
    if (years !== 1) {
      skipped.push({
        tld: row.tld,
        reason:
          `sold in a ${years}-year minimum term — the rate card stores annual prices, ` +
          `so storing this one would quote a ${years}-year amount as a single year`,
      });
      continue;
    }
    sync.push(row);
  }

  return { sync, skipped };
}
