/**
 * Mid-cycle pro-rata billing. Exact, in integer paise.
 *
 * ─── WHY THIS EXISTS SEPARATELY FROM add-seats.ts ───────────────────────────
 * add-seats.ts has done pro-rata since migration 0052 and had no tests. Reading
 * it against a calculator turned up five defects in live money code, and the two
 * that actually cost rupees are fixed by shape, not by care:
 *
 *   1. IT ROUNDED PER SEAT, THEN MULTIPLIED.
 *        proRataPerSeat = round(annualPerSeat × factor)   // to the nearest RUPEE
 *        subtotal       = proRataPerSeat × seats
 *      Rounding to a whole rupee per seat loses up to ₹0.50 each time, and that
 *      loss is then multiplied by the seat count. At ₹2,160/seat/year with 200 of
 *      365 days left: 1184 × 300 = ₹3,55,200 where the true figure is ₹3,55,068 —
 *      ₹132 charged that was never owed. Rounding must happen ONCE, at the end.
 *
 *      Note the drift is a function of the UNIT, not only of the shape: the same
 *      mistake in paise would cost half a paise a seat. Working in paise makes it
 *      negligible; rounding once makes it zero.
 *
 *   2. GST WAS HARDCODED AT 18% (`× 1.18`). An export customer is zero-rated —
 *      the quote builder already carries `effectiveTaxRate` for exactly this — so
 *      add-seats charged GST on sales that must not have any. Tax is a parameter
 *      here and there is no default.
 *
 * Also fixed: the term length was hardcoded to 365 and `days` clamped to [0,365],
 * so a two-year term silently billed as if it were annual. Both are parameters.
 *
 * ─── THE UNIT IS PAISE, AND IT IS AN INTEGER ────────────────────────────────
 * ₹1.22 is 122. Never 1.22. Floats cannot hold a tenth of a rupee exactly, and
 * money code that adds floats drifts in a way no test written after the fact can
 * find. Every value in and out of this module is integer paise; the only division
 * is the one below, and its result is rounded immediately.
 *
 * ⚠️ STORAGE IS STILL RUPEES. The database columns (subscriptions.mrr,
 * quotes.amount, vendor_bills.total) are `integer` and hold RUPEES — confirmed
 * against live rows, e.g. a ₹21,240 payment stored as 21240. Note that
 * CLAUDE.md §13 and utils.ts both claim paise; the data says otherwise and the
 * data wins. So callers convert at the boundary with `paiseToRupees`, and that
 * conversion is the one place a rupee is rounded off. Persisting paise would be a
 * migration across every money column — a separate, deliberate project.
 */

/** Integer paise. 100 = ₹1.00. Never fractional. */
export type Paise = number;

const isSafeInt = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && Number.isSafeInteger(n);

/**
 * Round half away from zero, deterministically.
 *
 * `Math.round` rounds half UP, so it treats −0.5 as 0 and +0.5 as 1 — the same
 * refund credited or debited would round differently. Credits are real here
 * (co-terming, downgrades), so the sign must not change the magnitude.
 */
function roundHalfAwayFromZero(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/** ₹12.34 → 1234. Rounds once, at the edge of the system. */
export function rupeesToPaise(rupees: number): Paise {
  if (typeof rupees !== "number" || !Number.isFinite(rupees)) {
    throw new Error(`rupeesToPaise: not a finite number (${String(rupees)})`);
  }
  return roundHalfAwayFromZero(rupees * 100);
}

/**
 * 1234 → 12 (whole rupees), for the integer rupee columns.
 *
 * This LOSES the paise, on purpose and in exactly one place, because the column
 * cannot hold them. Anything that needs the exact figure must carry paise.
 */
export function paiseToRupees(paise: Paise): number {
  if (!isSafeInt(paise)) throw new Error(`paiseToRupees: not an integer (${String(paise)})`);
  return roundHalfAwayFromZero(paise / 100);
}

/** 122 → "₹1.22". For screens and for notes on a quote. */
export function formatPaise(paise: Paise): string {
  if (!isSafeInt(paise)) return "—";
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}₹${whole.toLocaleString("en-IN")}.${frac}`;
}

export interface ProrationInput {
  /** List price for ONE seat for a FULL term, in paise. */
  annualPerSeatPaise: Paise;
  /** How many seats are being charged for. May be negative for a credit. */
  seats: number;
  /** Days left in the term. Clamped to [0, termDays] — never to 365. */
  remainingDays: number;
  /** Length of the whole term in days. 365, 366 in a leap year, 730, 30 — whatever it is. */
  termDays: number;
  /** GST percent. 18 for a domestic sale, 0 for a zero-rated export. No default, deliberately. */
  taxRatePct: number;
}

export interface ProrationResult {
  /** The fraction charged, as parts per million — an integer, so it can be logged
   *  and compared without a float appearing anywhere. 547945 = 54.7945%. */
  factorPpm: number;
  /** Days actually charged for, after clamping. */
  chargedDays: number;
  subtotalPaise: Paise;
  taxPaise:      Paise;
  totalPaise:    Paise;
  /** Per-seat share, for display ONLY. Multiplying this by seats is the bug this
   *  module exists to prevent, so it is never used to derive the subtotal. */
  perSeatPaise:  Paise;
}

/**
 * Pro-rata charge for `seats` seats over the remaining part of a term.
 *
 *   subtotal = round(annualPerSeat × seats × remainingDays ÷ termDays)
 *
 * One expression, one rounding. `seats` may be negative to price a credit (a
 * downgrade, or the giveback half of a co-term), and the arithmetic is symmetric.
 */
export function prorate(input: ProrationInput): ProrationResult {
  const { annualPerSeatPaise, seats, remainingDays, termDays, taxRatePct } = input;

  if (!isSafeInt(annualPerSeatPaise)) throw new Error("prorate: annualPerSeatPaise must be an integer (paise)");
  if (!isSafeInt(seats))              throw new Error("prorate: seats must be an integer");
  if (!Number.isFinite(remainingDays)) throw new Error("prorate: remainingDays must be a number");
  if (!isSafeInt(termDays) || termDays <= 0) throw new Error("prorate: termDays must be a positive integer");
  if (!Number.isFinite(taxRatePct) || taxRatePct < 0) throw new Error("prorate: taxRatePct must be >= 0");

  // Clamp to the ACTUAL term, not to a hardcoded year.
  const chargedDays = Math.max(0, Math.min(termDays, Math.round(remainingDays)));

  /* One expression, rounded once. The numerator stays well inside
     Number.MAX_SAFE_INTEGER for real inputs: ₹1,00,000/seat/year (1e7 paise) ×
     1000 seats × 730 days is 7.3e12, four orders of magnitude below the limit. */
  const subtotalPaise = roundHalfAwayFromZero(
    (annualPerSeatPaise * seats * chargedDays) / termDays,
  );

  const taxPaise = roundHalfAwayFromZero((subtotalPaise * taxRatePct) / 100);

  return {
    factorPpm:   roundHalfAwayFromZero((chargedDays * 1_000_000) / termDays),
    chargedDays,
    subtotalPaise,
    taxPaise,
    totalPaise:  subtotalPaise + taxPaise,
    // Display only. Derived from the subtotal so it can never disagree with it.
    perSeatPaise: seats === 0 ? 0 : roundHalfAwayFromZero(subtotalPaise / seats),
  };
}

/**
 * Whole days between two dates, by calendar date and not by elapsed hours.
 *
 * Timestamps would make the answer depend on the time of day a seat was added,
 * so a subscription bought at 11pm would bill a day less than one bought at 1am.
 * Billing runs on dates.
 */
export function daysBetweenDates(fromISO: string, toISO: string): number {
  const a = new Date(`${fromISO.slice(0, 10)}T00:00:00Z`).getTime();
  const b = new Date(`${toISO.slice(0, 10)}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) throw new Error(`daysBetweenDates: bad date (${fromISO} → ${toISO})`);
  return Math.round((b - a) / 86_400_000);
}
