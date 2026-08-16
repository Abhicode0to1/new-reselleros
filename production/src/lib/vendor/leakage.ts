/**
 * License leakage — seats you PAY the vendor for but do not BILL the customer for.
 *
 * ─── THREE SEAT COUNTS, AND CONFLATING THEM COSTS REAL MONEY ────────────────
 * Every subscription has three different numbers that all get called "seats":
 *
 *   vendorSeats  what Google/Microsoft has PROVISIONED and invoices you for.
 *                In the Google reseller export this is the "Purchased licenses"
 *                column — not assigned users.
 *   billedSeats  what ResellerOS charges the customer for (`subscriptions.seats`).
 *   assignedSeats  how many mailboxes actually have a human on them
 *                (`subscriptions.used`).
 *
 * They answer different questions and only one of them is about money leaving the
 * building:
 *
 *   vendorSeats > billedSeats   → UNDER-BILLED. You pay for seats nobody is charged
 *                                 for. This is margin bleeding out, every month, and
 *                                 it is what this module exists to find.
 *   billedSeats > vendorSeats   → OVER-BILLED. The customer pays for seats that were
 *                                 never provisioned. Not a windfall — it is a refund
 *                                 waiting to happen and a trust problem when found.
 *   assignedSeats < billedSeats → idle seats. A CHURN signal, not leakage: the
 *                                 customer is over-bought and will notice at renewal.
 *                                 Reported separately and never added to the money.
 *
 * The brief asks for "active Google Admin seats vs ResellerOS billed seats". Read
 * literally that compares assigned users to billing, which finds over-provisioned
 * customers rather than lost margin. Both are computed here; they are kept apart
 * because summing them would produce a number that means nothing.
 *
 * ─── NO VENDOR API IS CONNECTED ─────────────────────────────────────────────
 * `vendorSeats` arrives from the Google reseller CSV export through the existing
 * Reconcile dialog. There is no Google CSP or Microsoft Partner Center credential on
 * this project — both need partner onboarding, which is a commercial process. So
 * this module takes vendor seats as an INPUT and never pretends to fetch them, and a
 * subscription that has never been reconciled reports `unknown` rather than zero.
 * Zero would read as "no leakage" on precisely the rows nobody has checked.
 */

export type LeakageKind = "under_billed" | "over_billed" | "aligned" | "unknown";

export interface LeakageInput {
  /** What the vendor has provisioned and invoices us for. Null = never reconciled. */
  vendorSeats: number | null;
  /** What the customer is charged for. */
  billedSeats: number;
  /** Mailboxes with a human on them. Null when not tracked. */
  assignedSeats?: number | null;
  /** ₹/seat/month we pay the vendor. Null when the plan has no catalogue row. */
  costPerSeatMonth: number | null;
  /** ₹/seat/month the customer pays. Null when it cannot be derived. */
  pricePerSeatMonth: number | null;
}

export interface LeakageResult {
  kind: LeakageKind;
  /** vendorSeats − billedSeats. Positive = under-billed. Null when unknown. */
  seatGap: number | null;
  /** ₹/month the gap costs (under-billed) or over-charges (over-billed). Null when
   *  the per-seat figures are not known. */
  monthlyImpact: number | null;
  /** ₹/year, purely for headline framing. */
  annualImpact: number | null;
  /** billedSeats − assignedSeats, when both are known. Never money. */
  idleSeats: number | null;
  /** One sentence a non-technical owner can act on. */
  message: string;
}

/**
 * Work out the gap.
 *
 * `unknown` is a first-class outcome. A subscription that has never been reconciled
 * against the vendor has no vendor seat count, and reporting 0 leakage there would
 * put a clean tick on exactly the rows nobody has checked — the same
 * failure-as-a-plausible-value pattern this codebase keeps finding.
 */
export function assessLeakage(input: LeakageInput): LeakageResult {
  const billed = Math.max(0, Math.trunc(input.billedSeats));
  const assigned = input.assignedSeats == null ? null : Math.max(0, Math.trunc(input.assignedSeats));
  const idleSeats = assigned == null ? null : Math.max(0, billed - assigned);

  if (input.vendorSeats == null) {
    return {
      kind: "unknown",
      seatGap: null,
      monthlyImpact: null,
      annualImpact: null,
      idleSeats,
      message: "Never reconciled against the vendor, so we do not know how many seats they are billing us for.",
    };
  }

  const vendor = Math.max(0, Math.trunc(input.vendorSeats));
  const seatGap = vendor - billed;

  if (seatGap === 0) {
    return {
      kind: "aligned",
      seatGap: 0,
      monthlyImpact: 0,
      annualImpact: 0,
      idleSeats,
      message: `${billed} seats at the vendor, ${billed} billed — matched.`,
    };
  }

  /* Under-billed is costed at what we PAY (the money going out). Over-billed is
     costed at what the CUSTOMER pays (the amount that would have to be refunded).
     Using one rate for both would misstate whichever case it was not chosen for. */
  const rate = seatGap > 0 ? input.costPerSeatMonth : input.pricePerSeatMonth;
  const monthlyImpact = rate == null ? null : Math.abs(seatGap) * rate;

  if (seatGap > 0) {
    return {
      kind: "under_billed",
      seatGap,
      monthlyImpact,
      annualImpact: monthlyImpact == null ? null : monthlyImpact * 12,
      idleSeats,
      message: monthlyImpact == null
        ? `Paying the vendor for ${seatGap} more ${seatUnit(seatGap)} than the customer is billed for. This plan has no catalogue cost, so the amount is unknown.`
        : `Paying the vendor for ${seatGap} more ${seatUnit(seatGap)} than the customer is billed for — ₹${monthlyImpact.toLocaleString("en-IN")}/month of margin.`,
    };
  }

  const over = Math.abs(seatGap);
  return {
    kind: "over_billed",
    seatGap,
    monthlyImpact,
    annualImpact: monthlyImpact == null ? null : monthlyImpact * 12,
    idleSeats,
    message: monthlyImpact == null
      ? `Billing the customer for ${over} more ${seatUnit(over)} than the vendor has provisioned. Check before they do.`
      : `Billing the customer for ${over} more ${seatUnit(over)} than the vendor has provisioned — ₹${monthlyImpact.toLocaleString("en-IN")}/month they may ask back.`,
  };
}

function seatUnit(n: number): string {
  return n === 1 ? "seat" : "seats";
}

/**
 * Roll several subscriptions up into a headline.
 *
 * Under- and over-billing are NOT netted. ₹5,000 lost on one customer and ₹5,000
 * over-charged on another is not "no problem" — it is two problems, one of which is
 * a refund. A net of zero would hide both.
 */
export function leakageTotals(results: readonly LeakageResult[]): {
  underBilledMonthly: number;
  overBilledMonthly: number;
  underBilledCount: number;
  overBilledCount: number;
  unknownCount: number;
  /** Rows where the gap is real but the money could not be priced. */
  unpricedCount: number;
} {
  let underBilledMonthly = 0, overBilledMonthly = 0;
  let underBilledCount = 0, overBilledCount = 0, unknownCount = 0, unpricedCount = 0;

  for (const r of results) {
    if (r.kind === "unknown") { unknownCount++; continue; }
    if (r.kind === "aligned") continue;
    if (r.monthlyImpact == null) unpricedCount++;
    if (r.kind === "under_billed") {
      underBilledCount++;
      underBilledMonthly += r.monthlyImpact ?? 0;
    } else {
      overBilledCount++;
      overBilledMonthly += r.monthlyImpact ?? 0;
    }
  }

  return { underBilledMonthly, overBilledMonthly, underBilledCount, overBilledCount, unknownCount, unpricedCount };
}

/** Worst first: biggest money, then unpriced gaps, then unknowns, then matched. */
export function leakageSortKey(r: LeakageResult): number {
  if (r.kind === "under_billed") return -(r.monthlyImpact ?? 1) - 1_000_000;
  if (r.kind === "over_billed")  return -(r.monthlyImpact ?? 1);
  if (r.kind === "unknown")      return 1;
  return 2;
}
