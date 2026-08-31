/**
 * The covering letter for a quotation — every figure carrying its own unit.
 *
 * ─── THE EMAIL THAT ASKED FOR THIS ──────────────────────────────────────────
 * 31 Aug 2026, Q-ADPL-2026-27-0068 as the customer received it:
 *
 *     QUOTE Q-ADPL-2026-27-0068
 *       25 × Google Workspace Business Starter — ₹8,125
 *
 *       Subtotal   ₹8,125
 *       GST 18%    ₹1,463
 *       TOTAL      ₹9,588
 *
 *     Valid until 2026-09-07.
 *
 * Pardeep's reading of it was one sentence: "monthly quotation hai" — and the word *monthly*
 * appeared nowhere. ₹8,125 reads as a one-off, or a year. The PDF attached to that very mail
 * said "Rs 325/seat/mo · Commitment — None, cancel any month". The document and its covering
 * letter were describing the same money differently, which is the exact shape that cost this
 * project twice already: a monthly rate divided by twelve on a GST document, and a flex plan
 * printing a year nobody agreed to.
 *
 * So every figure here states its unit, the per-seat rate is spelled out because that is the
 * number a customer actually checks, and the commitment is a line of its own.
 *
 * ─── AND NOTHING IS RECOMPUTED ──────────────────────────────────────────────
 * Every amount arrives from the quote row. Two places doing the same arithmetic is how an
 * email and its attachment come to differ by a rupee, and that is a conversation nobody wants
 * to have with a customer.
 *
 * A pure function so it can be read in a test. It used to be a template literal buried in
 * `sendAutoQuote`, reachable only by sending real mail — which is why it went months without
 * anybody noticing it never said "monthly".
 */
import { rupee, formatDate } from "@/lib/utils";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

export interface QuoteBodyInput {
  quoteId: string;
  customerName: string | null;
  sellerName: string;
  lineItems: QuoteLineItem[];
  /** Quote-level invoice frequency. Null falls back to the line's own commitment. */
  billingCycle: string | null;
  /** All from the quote row — never recalculated here. */
  subtotal: number;
  discountPct: number;
  discount: number;
  taxRate: number;
  tax: number;
  total: number;
  /** ISO date on the row; rendered in Indian format. */
  expiresDate: string | null;
  /**
   * The migration offer, in words, or null to leave it out.
   *
   * A COMMERCIAL PROMISE and therefore a parameter, not a hardcoded sentence: "free
   * migration" is the kind of line this repo refuses to let a model invent, and a template
   * inventing it is no better. The caller passes the tenant's standing offer.
   */
  migrationOffer?: string | null;
}

/** What one invoice covers, in words a customer reads. */
export function cycleUnitSuffix(cycle: string): string {
  switch (cycle) {
    case "monthly":     return "/month";
    case "quarterly":   return "/quarter";
    case "half_yearly": return "/half-year";
    default:            return "";
  }
}

/**
 * The app's OWN date format, not a second one.
 *
 * The email printed the raw `2026-09-07`. My first fix rolled its own formatter and produced
 * "07 Sep 2026" — which no other screen in this app shows. `formatDate` renders "7 Sept 2026"
 * (en-IN's short month is four letters), and every screen and both PDFs already use it. A
 * covering letter dated differently from the document it covers is a smaller version of the
 * same problem this file exists to fix.
 *
 * Returns null rather than `formatDate`'s em dash, so an unusable date drops the whole
 * "valid until" line instead of printing "valid until —".
 */
export function indianDate(iso: string | null): string | null {
  if (!iso) return null;
  if (Number.isNaN(new Date(iso).getTime())) return null;
  return formatDate(iso);
}

export function quoteEmailBody(input: QuoteBodyInput): string {
  const first  = input.lineItems[0];
  const isFlex = first?.commitment === "monthly";
  const cycle  = (input.billingCycle ?? (isFlex ? "monthly" : "yearly")).toLowerCase();
  const unit   = cycleUnitSuffix(cycle);

  /* The flex tier's rate is per seat per MONTH; an annual line's is per seat per YEAR. That
     boundary is the one `lib/quotes/commitment-rate.ts` documents and three SQL tests pin —
     and stating it wrongly here would put the same 12x error in the covering letter. */
  const perSeat = isFlex ? "per seat per month" : "per seat per year";

  const lines = input.lineItems
    .map((li) => [
      `  ${li.qty} × ${li.name}`,
      `      ${rupee(li.rate)} ${perSeat}`,
      `      ${rupee(li.qty * li.rate)}${unit}`,
    ].join("\n"))
    .join("\n\n");

  /* On flex this SELLS rather than warns: the rate is higher precisely because nothing is
     locked in, so saying so is the argument for the tier. */
  const commitment = isFlex
    ? "Commitment      None — billed monthly, cancel or change seats any month"
    : `Commitment      Annual, ${cycle === "monthly" ? "billed monthly" : "billed yearly"}`;

  const totalLabel = cycle === "yearly"
    ? "TOTAL          "
    : cycle === "monthly" ? "PAYABLE EACH MONTH" : "PAYABLE EACH PERIOD";

  const valid = indianDate(input.expiresDate);

  const next = [
    "WHAT HAPPENS NEXT",
    "  1. Confirm by replying to this email and we will raise the tax invoice.",
    input.migrationOffer
      ? `  2. Once payment is received we provision the accounts. ${input.migrationOffer}`
      : "  2. Once payment is received we provision the accounts.",
  ].join("\n");

  return [
    `Dear ${input.customerName?.trim() || "Sir/Madam"},`,
    "",
    "Thank you for your enquiry. Our quotation is attached as a PDF; the figures are",
    "summarised below for your convenience.",
    "",
    `QUOTATION ${input.quoteId}`,
    lines,
    "",
    `  Subtotal        ${rupee(input.subtotal)}${unit}`,
    ...(input.discountPct > 0
      ? [`  Discount ${input.discountPct}%     -${rupee(input.discount)}${unit}`]
      : []),
    `  GST ${input.taxRate}%          ${rupee(input.tax)}${unit}`,
    `  ${totalLabel}  ${rupee(input.total)}${unit}`,
    "",
    `  ${commitment}`,
    "  HSN / SAC       998313 (software as a service)",
    ...(valid ? ["", `This quotation is valid until ${valid}.`] : []),
    "",
    next,
    "",
    "If anything needs changing — the number of seats, the plan, or the billing term —",
    "simply reply to this email and we will send a revised quotation.",
    "",
    "Kind regards,",
    input.sellerName,
  ].join("\n");
}
