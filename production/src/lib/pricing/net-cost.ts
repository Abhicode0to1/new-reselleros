/**
 * What this quote actually costs the buyer after they reclaim the GST on it.
 *
 * ─── EVERY NUMBER HERE COMES OFF OUR OWN INVOICE ────────────────────────────
 * That constraint is the design, not a limitation of it. The brief asked for a "Net Savings"
 * block comparing us with buying direct from Google:
 *
 *     "Direct Google website se khareedne par aapko 3.5% Credit Card Forex Fee + 18% Reverse
 *      Charge GST lagta hai jiska ITC claim nahi milta"
 *     "Free Email Migration Support: ₹15,000 Value FREE"
 *     "Total Net Savings with Anutech: ₹26,610!"
 *
 * Three of those claims are not ours to make, and this module makes none of them:
 *
 *   1. GOOGLE'S TAX TREATMENT. Google bills Indian customers through Google Cloud India
 *      Pvt Ltd, with an Indian GSTIN — a domestic supply carrying ordinary GST and ordinary
 *      input tax credit. Reverse charge applies to an IMPORT of service from a foreign
 *      supplier. Which of those a given customer gets depends on which Google entity invoices
 *      them, which we cannot know. An automated message asserting "you get no ITC from
 *      Google" would be a factual claim about a competitor that may simply be false.
 *   2. THE BUYER'S CARD. A 3.5% foreign-currency markup is a fact about their bank, not
 *      about Google and not about us. Issuers charge roughly 1.75%–3.5%. "Aapko 3.5% lagta
 *      hai" is a statement about a contract we have never seen.
 *   3. A ₹15,000 MIGRATION VALUE. There is no migration SKU in this catalogue — measured
 *      25 Aug 2026. That figure would be a hardcoded rupee number with no source, which is
 *      the defect AGENTS.md L106 was written about the same week, and it would inflate a
 *      "total savings" line with a price nobody has ever charged anybody.
 *
 * What is left is stronger than what was asked for, because the buyer can check it against
 * the document in their hand: this is your GST, this is what you can reclaim, this is your
 * net cost. No comparison, nothing to disprove.
 *
 * ─── AND THE ITC LINE IS GATED ON A GSTIN WE ACTUALLY HAVE ──────────────────
 * Input tax credit is worth nothing to a business that is not GST-registered. Measured on
 * production 25 Aug 2026: 16 of 28 leads have NO GSTIN on record. Telling those sixteen they
 * are "saving" the GST is not optimistic phrasing, it is false — so the claim requires a
 * GSTIN that passes `isValidGstin`, and says something different when there is none.
 *
 * ─── ITC IS NOT A SAVING, AND THE WORDING SAYS SO ───────────────────────────
 * It is tax the buyer pays us and then reclaims from the government. That is a real benefit
 * — cash back in their pocket, and a reason to buy on an Indian invoice — but calling it
 * "₹22,395 saved" overstates it, because they were never going to keep that money either
 * way. "Claimable" is the honest word and it is the one used throughout.
 */
import { isValidGstin } from "@/lib/utils";

export interface NetCostInput {
  /** Ex-GST, before the volume discount. Whole rupees. */
  subtotal: number;
  /** From the volume rate card. 0 when none applied. */
  discountPct: number;
  /** Percent, normally 18 for SaaS (HSN 998313). */
  taxRate: number;
  /** `leads.gstin` / `customers.gstin`. Null, blank or malformed all mean "cannot claim". */
  buyerGstin: string | null | undefined;
}

export interface NetCost {
  /** Ex-GST after the volume discount. */
  taxableValue: number;
  /** The discount in rupees, 0 when none. */
  discountValue: number;
  /** GST on the taxable value. */
  gst: number;
  /** What the buyer pays us, incl-GST. Matches `quotes.amount`. */
  payable: number;
  /** GST reclaimable as input tax credit — 0 when we have no valid GSTIN for them. */
  itcClaimable: number;
  /** True when a valid GSTIN is on record, so the ITC line may be stated at all. */
  itcApplicable: boolean;
  /** Payable less reclaimable GST. Equals `payable` when there is no ITC. */
  netCost: number;
}

/**
 * The arithmetic, in the same order and with the same rounding every screen that renders a
 * quote uses — `discount = round(subtotal × pct/100)`, then GST on what is left. Two paths
 * computing one figure is what this codebase keeps getting burned by, so this follows the
 * document rather than inventing a tidier sum.
 */
export function computeNetCost(input: NetCostInput): NetCost {
  const subtotal = Math.max(0, Math.round(input.subtotal));
  const pct = Number.isFinite(input.discountPct) ? input.discountPct : 0;
  const discountValue = Math.round(subtotal * (pct / 100));
  const taxableValue = subtotal - discountValue;

  const rate = Number.isFinite(input.taxRate) ? input.taxRate : 0;
  const gst = Math.round(taxableValue * (rate / 100));
  const payable = taxableValue + gst;

  const itcApplicable = isValidGstin((input.buyerGstin ?? "").trim());
  const itcClaimable = itcApplicable ? gst : 0;

  return {
    taxableValue,
    discountValue,
    gst,
    payable,
    itcClaimable,
    itcApplicable,
    netCost: payable - itcClaimable,
  };
}

/** Rs, whole rupees, Indian grouping. Matches the agent's own formatter. */
function rupees(n: number): string {
  return `Rs ${Math.round(n).toLocaleString("en-IN")}`;
}

/**
 * The block the agent may state, as sentences the app wrote.
 *
 * Returned as lines rather than a paragraph so the caller can render them into an email, a
 * WhatsApp message or a quote note without re-wording anything. The model does not compose
 * these and does not do the arithmetic behind them — it is handed finished sentences, the same
 * discipline `authorisedTotalsFor` established.
 *
 * `sellerName` is passed in rather than read from env, so this stays pure and so a second
 * reseller on this deployment cannot end up with ANUTECH's name in their own quote.
 */
export function netCostLines(net: NetCost, sellerName: string): string[] {
  const lines: string[] = [];

  if (net.discountValue > 0) {
    lines.push(`Volume discount applied: ${rupees(net.discountValue)} off the list total.`);
  }

  lines.push(`Amount payable, including GST: ${rupees(net.payable)}.`);

  if (net.itcApplicable) {
    lines.push(
      `Of that, ${rupees(net.itcClaimable)} is GST you can claim back as input tax credit, ` +
      `because this is an Indian tax invoice issued by ${sellerName} against your GSTIN.`,
    );
    lines.push(`Your net cost after claiming it: ${rupees(net.netCost)}.`);
  } else {
    /* No GSTIN on record. Not silence and not a claim — an invitation, because the number is
       real and the only missing input is theirs. CLAUDE.md §24: say what is missing and who
       can supply it. */
    lines.push(
      `${rupees(net.gst)} of this is GST. Share your GSTIN and we will raise the invoice ` +
      "against it, so you can claim that back as input tax credit.",
    );
  }

  /* Billing currency. A FACT about our invoice — no percentage, no mention of anybody's card
     or of what a foreign supplier would charge. A buyer who has paid a forex markup before
     knows exactly what this sentence is worth; one who has not is not being told a number we
     invented for them. */
  lines.push(
    "Billed in rupees on an Indian invoice, so there is no foreign-currency conversion on " +
    "your card or your bank statement.",
  );

  return lines;
}

/**
 * Every rupee figure `netCostLines` can emit, for the money guard's allow-list.
 *
 * Same rule as the volume rate card: the guard's list and the stated figures come from one
 * computation. A correct net-cost figure that the guard flags would hand over every quote
 * that mentioned it — and a figure the app would never produce must never be authorised.
 */
export function authorisedNetCostFigures(net: NetCost): number[] {
  const out = new Set<number>([net.payable, net.gst, net.netCost, net.taxableValue]);
  if (net.discountValue > 0) out.add(net.discountValue);
  if (net.itcClaimable > 0) out.add(net.itcClaimable);
  return [...out];
}
