import { samePlan as samePlanOf } from "@/lib/leads/apply-correction";

/**
 * A customer replied on a lead that already exists. Do they need a new quote?
 *
 * ─── THE GAP THIS CLOSES, AND IT WAS MINE ───────────────────────────────────
 * Measured on a live self-test, 23 Aug 2026. A mail reading "quotation for 50 Google
 * Workspace Business Starter users on annual billing" arrived from an address that already
 * had an open lead, so the webhook APPENDED it — correctly, by the identity-before-
 * classification rule. The deterministic extractor then did its job and rewrote the lead:
 * seats 20 → 50, plan Business Standard → Business Starter.
 *
 * And no quote was drafted, because I had wired the auto-quote block onto the CREATE branch
 * only. That is backwards. A reply from somebody already in conversation, stating a seat
 * count and a plan, is the MOST quote-worthy mail this app receives — a first enquiry is
 * often vaguer. I wired the auto-REPLY to both branches and the auto-QUOTE to one, and
 * nothing in the tests could see it because the tests exercise the decision, not the wiring.
 *
 * ─── WHY THIS IS A DECISION AND NOT AN `if` ─────────────────────────────────
 * Because the wrong answer costs a number. Every quote takes one from the gapless CGST
 * Rule 46 series and cannot give it back, so "draft a quote whenever a reply mentions
 * seats" would burn one on every follow-up in a long thread — five mails about the same
 * 50 seats, five documents. The whole job here is deciding when NOT to.
 */

/* samePlan is IMPORTED, not reimplemented. The first version of this file had its own copy
   of the normalisation, which is the mistake this repo keeps recording: two comparisons that
   drift apart, so a reply is a "change" to one and not to the other.

   Its limitation is real and worth knowing rather than papering over: containment fails when
   the dropped word is in the MIDDLE, so "google-workspace-starter" and "Google Workspace
   Business Starter" read as different plans. In practice that costs ONE extra quote on a
   lead still carrying a buy-page slug — the correction write-back then normalises the row
   onto the catalogue name and it settles. Widening it to token-subset matching would be
   better and is a separate change: samePlan's own comment warns that "Business Starter" and
   "Business Standard" must never collapse, and that warning is load-bearing. */
export interface RequoteInput {
  /** Current lead facts, after any corrections this reply applied. */
  seats: number | null;
  /** The catalogue product name now on the lead. Null when nothing matched. */
  productName: string | null;
  /**
   * The term the CUSTOMER has now stated, or null when they still have not said.
   *
   * Added 31 Aug 2026, and it was the missing fact. Q-ADPL-2026-27-0055 was drafted at 32
   * seats on an ASSUMED annual term and correctly not sent, because monthly and annual differ
   * by twelve. When the customer then wrote "monthly", this function saw the same seats and
   * the same plan, answered "the reply does not change what they asked for", and the draft sat
   * unsent for ever. The one fact that unblocks the send was not part of the decision.
   */
  term: "monthly" | "annual" | null;
  /** The most recent quote on this lead, whatever its status. */
  latestQuote: {
    id: string;
    status: string | null;
    seats: number | null;
    plan: string | null;
    /** How that quote was priced. "monthly" is the flex tier; anything else is annual. */
    billingCycle: string | null;
  } | null;
}

export interface RequoteDecision {
  requote: boolean;
  reason: string;
  /**
   * Re-price THIS draft in place instead of raising a new number.
   *
   * Pardeep's decision, 31 Aug 2026, asked with the alternative on the table. Every quote
   * takes an irreversible number from the gapless CGST Rule 46 series; an UNSENT draft that
   * was priced on a guess is not a document anybody has seen, so correcting it costs nothing
   * and keeps the series tight. It also keeps a promise already made — the agent had told the
   * customer that quotation's number.
   *
   * Only ever set for a quote whose status is `draft`. An issued document's figures are
   * frozen; a customer who was SENT 20 seats and now wants 50 gets a new document, not a
   * rewritten one.
   */
  repriceDraftId?: string;
}

export function shouldRequoteOnReply(input: RequoteInput): RequoteDecision {
  if (input.seats == null || !input.productName) {
    /* Not a refusal to quote so much as nothing to quote. The planner would decline anyway;
       saying it here keeps the reason on the lead's timeline instead of one layer down. */
    return {
      requote: false,
      reason:
        "the reply does not give both a seat count and a catalogue product, so there is " +
        "nothing to price",
    };
  }

  if (!input.latestQuote) {
    return { requote: true, reason: "this lead has no quote yet and the reply says what to price" };
  }

  const q = input.latestQuote;
  const sameSeats = q.seats != null && q.seats === input.seats;
  const samePlan  = samePlanOf(input.productName, q.plan);

  if (sameSeats && samePlan) {
    /* ── THE TERM ARRIVING IS A CHANGE, EVEN WHEN NOTHING ELSE MOVED ──────────
       Q-ADPL-2026-27-0055, 31 Aug 2026: 32 seats of Business Starter, drafted on an ASSUMED
       annual term and correctly not sent. The customer then wrote "monthly" — same seats,
       same plan — and everything below said "nothing changed", so the draft stayed annual and
       unsent, and the reply promising a quotation was never kept.

       The document is a DRAFT, so it can be corrected rather than replaced: same number, right
       price. That keeps the gapless Rule 46 series tight and makes the reference the agent
       already gave the customer true. An issued document is never touched — the guard below
       is the `status` check, not a comment. */
    const draftOnWrongTerm =
      q.status === "draft" &&
      input.term !== null &&
      q.billingCycle !== null &&
      (input.term === "monthly") !== (q.billingCycle === "monthly");

    if (draftOnWrongTerm) {
      return {
        requote: true,
        reason:
          `${q.id} is an unsent draft priced ${q.billingCycle === "monthly" ? "monthly" : "annually"}` +
          ` and the reply now says ${input.term} — re-pricing that draft rather than raising a` +
          " second number",
        repriceDraftId: q.id,
      };
    }

    /* THE ONE THAT SAVES DOCUMENT NUMBERS. A thread about the same 50 seats can run five
       messages long; without this, each one is a new GST document for a requirement that
       has not moved. */
    return {
      requote: false,
      reason:
        `${q.id} already quotes ${input.seats} × ${input.productName} — the reply does not ` +
        "change what they asked for",
    };
  }

  /* It differs, so the existing quote is now wrong about what they want. Note this fires for
     a SENT quote too, and that is deliberate: a customer who has been sent 20 seats and now
     says 50 needs a revised document, not a note on a lead. What it must NOT do is alter the
     old one — the caller drafts a new quote, and lib/quotes tests cover that the issued
     figures on the old one are frozen. */
  const what = !sameSeats && !samePlan
    ? `the seats and the plan both changed since ${q.id}`
    : !sameSeats
      ? `the seat count changed since ${q.id} (${q.seats ?? "unknown"} → ${input.seats})`
      : `the plan changed since ${q.id} (${q.plan ?? "unknown"} → ${input.productName})`;

  return { requote: true, reason: what };
}
