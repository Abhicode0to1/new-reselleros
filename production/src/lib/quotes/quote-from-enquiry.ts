/**
 * Turning an inbound enquiry into a draft quote — the decision, separated from the writing.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Traced on 23 Aug 2026, asked as "50 Business Starter ka quote maangu to email par aa
 * jayega?". The answer was no, and the break was not where it looked: `/buy/workspace`
 * already auto-creates a draft quote from a form submission, but the inbound-email webhook
 * only ever inserted a lead. Nothing on the email path has ever produced a quote.
 *
 * The webhook is a 700-line route that has already been the source of two shipped bugs
 * (a lead created from our own forwarded mail; a reply spam-filtered off its own thread).
 * Putting money arithmetic inline there would make it a third. So the ARITHMETIC and the
 * REFUSALS live here, where they can be tested against a table of inputs, and the route
 * keeps only the writing.
 *
 * ─── IT MOSTLY REFUSES, AND SAYS WHY ────────────────────────────────────────
 * Four of the five outcomes are refusals. That is the point: a quote nobody asked for, or
 * one built on a seat count nobody read correctly, is worse than no quote — it is a
 * five-figure GST document with a wrong number on it, and it consumes an irreversible
 * number from the gapless Rule 46 series to do so. Every refusal carries a reason the
 * operator can act on, per CLAUDE.md §24; none of them is a silent null.
 *
 * ─── THE TERM IS ANNUAL, AND THAT IS A CHOICE ───────────────────────────────
 * An email says "50 Business Starter". It does not say monthly or annual, and there is no
 * honest way to read one out of the other. Annual is used because:
 *   - `buildWorkspaceLines` (the form path) already commits to `annual_yearly`, and two
 *     paths quoting the same product on different terms would be worse than either choice;
 *   - the output is a DRAFT. A human opens it before a customer ever sees it, and the term
 *     is the first thing on the line.
 * The choice is stated on the quote's own notes field by the caller, so whoever opens the
 * draft reads "annual, assumed" rather than discovering it from the arithmetic.
 *
 * If auto-SENDING is ever wired to this, that reasoning stops holding — an assumed term
 * that no human checked would reach the customer. Revisit here first.
 */

/** ₹ per seat per MONTH, as the `items` table stores them (whole rupees — AGENTS.md). */
export interface CatalogueItemPrice {
  id: string;
  name: string;
  msrp: number | null;
  wholesale: number | null;
}

/** One quote line, shaped exactly as `buildWorkspaceLines` shapes it. */
export interface EnquiryQuoteLine {
  id: string;
  name: string;
  qty: number;
  /** ₹ per seat per YEAR — msrp × 12, because the commitment is annual. */
  rate: number;
  cost: number;
  commitment: "annual_yearly" | "monthly";
}

export type EnquiryQuotePlan =
  | { ok: false; reason: string }
  | {
      ok: true;
      items: EnquiryQuoteLine[];
      /** ex-GST, whole rupees. */
      subtotal: number;
      /** incl-GST at 18%, whole rupees. */
      amount: number;
      /** For the draft's notes, so the assumption is readable and not inferred. */
      assumption: string;
      /** False when the mail named the term. The auto-send gate reads THIS, not the text. */
      termAssumed: boolean;
    };

export interface PlanQuoteInput {
  item: CatalogueItemPrice | null;
  seats: number | null;
  /** From extractEntities().term — null means the sender never said. */
  term?: "monthly" | "annual" | null;
  /** Injected so the plan is deterministic under test — the route passes crypto. */
  newLineId?: () => string;
}

export function planQuoteFromEnquiry(input: PlanQuoteInput): EnquiryQuotePlan {
  const { item, seats } = input;

  if (!item) {
    return {
      ok: false,
      reason:
        "the mail did not name a product from this tenant's catalogue — the lead is saved, " +
        "build the quote from it once the product is confirmed",
    };
  }

  if (seats == null) {
    /* The commonest refusal by far, and deliberately not guessed at. A quote for the wrong
       number of seats is not a smaller error than no quote; it is a bigger one, because it
       looks finished. */
    return {
      ok: false,
      reason:
        `no seat count could be read from the mail, so "${item.name}" has no quantity — ` +
        "the lead is saved with the product, add the seats and the quote builder is one tap",
    };
  }

  if (!Number.isInteger(seats) || seats <= 0 || seats > 9999) {
    return { ok: false, reason: `seat count ${seats} is not a quantity anyone orders — no quote built` };
  }

  const monthlyMsrp = item.msrp ?? 0;
  if (!Number.isFinite(monthlyMsrp) || monthlyMsrp <= 0) {
    /* Enterprise tiers and anything hand-priced land here, which is correct: the form path
       skips Enterprise for exactly this reason rather than quoting a zero. */
    return {
      ok: false,
      reason:
        `"${item.name}" has no sell price in the catalogue, so it is priced by hand — ` +
        "the lead is saved, price it and send",
    };
  }

  /* Cost may legitimately be absent — margin then reads as unknown rather than as 100%,
     which is what a 0 would have claimed. */
  const monthlyCost = Number.isFinite(item.wholesale ?? NaN) ? (item.wholesale as number) : 0;

  /* TERM. Stated when the sender said so, annual when nobody did — and `termAssumed`
     records which, because the two are not interchangeable downstream. The units differ,
     not just the number: `annual_yearly` carries ₹/seat/YEAR and `monthly` carries
     ₹/seat/MONTH, which is the boundary lib/quotes/commitment-rate.ts exists to police.
     Writing a monthly rate onto an annual line is a 12× error in the customer's favour or
     ours depending on direction, and both are unacceptable on a GST document. */
  const termAssumed = input.term == null;
  const term = input.term ?? "annual";
  const annual = term === "annual";

  const newId = input.newLineId ?? (() => globalThis.crypto.randomUUID());
  const items: EnquiryQuoteLine[] = [{
    id:         newId(),
    name:       item.name,
    qty:        seats,
    rate:       annual ? monthlyMsrp * 12 : monthlyMsrp,
    cost:       annual ? monthlyCost * 12 : monthlyCost,
    commitment: annual ? "annual_yearly" : "monthly",
  }];

  const subtotal = items.reduce((s, i) => s + i.qty * i.rate, 0);
  /* One rounding, at the end, on the ex-GST total — the same single-rounding rule
     buildWorkspaceLines follows, so the two paths cannot disagree by a rupee on the same
     product and seat count. */
  const amount = Math.round(subtotal * 1.18);

  return {
    ok: true,
    items,
    subtotal,
    amount,
    termAssumed,
    assumption: termAssumed
      ? `Term ASSUMED annual (₹${monthlyMsrp}/seat/month × 12). The mail did not say ` +
        "monthly or annual — check this line before sending."
      : `Term ${term.toUpperCase()}, as stated in the mail (₹${monthlyMsrp}/seat/month` +
        `${annual ? " × 12" : ""}).`,
  };
}
