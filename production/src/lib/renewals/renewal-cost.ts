/**
 * What a renewal COSTS us — read from the catalogue, never guessed.
 *
 * ─── WHY (R-012, raised by Pawan 26 Sep 2026) ───────────────────────────────
 * `createRenewalQuote` priced its own cost as:
 *
 *     const perSeatCost = Math.round((annualAmount * 0.83) / seats);
 *     total_cost:        Math.round(annualAmount * 0.83)
 *
 * That is a hardcoded 17% margin standing in for the vendor's real price — the exact
 * defect AGENTS.md §2 lists by name. On Business Starter the real wholesale is ₹110 per
 * seat per month; 0.83 of the selling price says about ₹224. Double. So every renewal
 * quote carried a margin figure that was invented, and it was invented in a way that
 * agrees with itself forever: the "margin" was 17% because it was defined to be 17%.
 *
 * ─── WHY ZERO MEANS UNKNOWN, AND WHY THAT IS NOT A NEW IDEA ─────────────────
 * A bespoke plan has no catalogue row, so sometimes there genuinely is no cost to read.
 * The request says: do not guess, and do not let 0 read as 100% margin.
 *
 * This codebase already had the answer. `lib/quotes/approval-economics.ts` computes
 *
 *     if (l.cost <= 0 && l.rate > 0) costUnknown = true;
 *
 * so a zero cost against a real rate is ALREADY read as "we do not know", not as free.
 * Returning 0 with `known: false` therefore hands the existing reader the right answer
 * instead of inventing a nullable field that every other reader would have to learn.
 * The caller logs it; `costUnknown` is what the approval matrix acts on.
 *
 * ─── THE UNIT, WHICH IS THE OTHER HALF OF THE BUG ───────────────────────────
 * `items.wholesale` is ₹ per seat per MONTH (AGENTS.md §1). A renewal covers
 * `termMonths` of them. Multiplying by 12 regardless — the sibling mistake to the one
 * L104 records — would make a monthly renewal's cost twelve times the truth and turn a
 * healthy margin into a loss on screen.
 */

export interface RenewalCostInput {
  /** `items.wholesale` — ₹ per seat per MONTH. Null when the catalogue has no price. */
  wholesalePerSeatMonth: number | null | undefined;
  /** Months this renewal covers, from `renewalTerm()`: 1 for monthly, 12 for annual. */
  termMonths: number;
  seats: number;
}

export interface RenewalCost {
  /** ₹ per seat for the WHOLE term. 0 when unknown. */
  perSeat: number;
  /** ₹ for the whole line. 0 when unknown. */
  total: number;
  /**
   * False when the catalogue could not price it. The caller must not substitute a
   * figure; `approval-economics` reads `cost <= 0` as unknown and says so on screen.
   */
  known: boolean;
  /** Why it is unknown, for the log. Null when it is known. */
  reason: string | null;
}

export function renewalCost(input: RenewalCostInput): RenewalCost {
  const seats = Math.max(0, Math.trunc(input.seats ?? 0));
  const months = Math.max(0, Math.trunc(input.termMonths ?? 0));
  const wholesale = input.wholesalePerSeatMonth;

  const unknown = (reason: string): RenewalCost => ({ perSeat: 0, total: 0, known: false, reason });

  /* A zero or negative wholesale is a blank field, not a free product — the same
     reading `lib/vendor/cogs.ts` takes of the same column. */
  if (wholesale == null || !Number.isFinite(wholesale) || wholesale <= 0) {
    return unknown("the catalogue has no wholesale price for this plan");
  }
  if (months <= 0) return unknown("the renewal term is not known, so a per-month cost cannot be totalled");
  if (seats <= 0) return unknown("the subscription has no seat count");

  const perSeat = Math.round(wholesale * months);
  return { perSeat, total: perSeat * seats, known: true, reason: null };
}
