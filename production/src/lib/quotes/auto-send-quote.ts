/**
 * Should the app send this auto-drafted quote to the customer by itself?
 *
 * ─── THE RULE, AND WHOSE RULE IT IS ─────────────────────────────────────────
 * Pardeep's, chosen on 23 Aug 2026 from four options with the cost of each stated:
 * **send when the mail named the term, hold when it did not.**
 *
 * The reason a rule was needed at all: monthly and annual differ by 12×, and an email
 * saying "50 Business Starter" names neither. A draft may assume — a person opens it and
 * the term is the first line on the document. An unattended send may not: a price the app
 * inferred and posted is a price the customer can reasonably hold us to, and no amount of
 * small print underneath repairs the first number they read.
 *
 * So the gate is not a confidence score and not a keyword search at send time. It is
 * `termAssumed` from lib/quotes/quote-from-enquiry.ts, which is false only when
 * `extractEntities().term` found the sender's own words. One place decides; this reads it.
 *
 * ─── WHY THIS IS A DECISION FUNCTION AND NOT AN IF-STATEMENT ─────────────────
 * Five things have to be true before a quote leaves the building, and four of them fail
 * quietly. An inline condition in a 700-line webhook would be reviewed once; this is
 * reviewed by a table of cases, and each refusal carries the sentence the operator sees on
 * the lead — which is the difference between "the app did nothing" and "the app is waiting
 * on you for the term".
 */

export interface AutoSendInput {
  /** From the quote plan. True when nobody stated monthly or annual. */
  termAssumed: boolean;
  /** The address the enquiry arrived from. */
  recipient: string | null | undefined;
  /** Whether a draft was actually created — no quote, nothing to send. */
  quoteId: string | null;
  /** `isEmailConfigured()` — a Resend key exists. */
  emailConfigured: boolean;
  /**
   * True when the sender is one of our own addresses. Belt and braces: the disposition
   * guard already skips those before a lead exists, so this should be unreachable — and it
   * is checked anyway, because the one thing worse than not sending is auto-replying to
   * ourselves in a loop.
   */
  senderIsOurs?: boolean;
}

export type AutoSendDecision =
  | { send: true }
  | { send: false; reason: string };

export function decideAutoSend(input: AutoSendInput): AutoSendDecision {
  if (input.senderIsOurs) {
    return { send: false, reason: "the sender is one of our own addresses — nothing is sent back to ourselves" };
  }

  if (!input.quoteId) {
    return { send: false, reason: "no draft quote was created, so there is nothing to send" };
  }

  const to = (input.recipient ?? "").trim();
  if (!to || !to.includes("@")) {
    /* Cannot happen through the webhook — the address is how the mail arrived. Stated
       rather than assumed, because "send to empty string" is the kind of thing that turns
       into a provider error nobody reads. */
    return { send: false, reason: "the enquiry carried no usable reply address" };
  }

  if (!input.emailConfigured) {
    return { send: false, reason: "email sending is not configured on this deployment" };
  }

  if (input.termAssumed) {
    /* THE RULE. Note what this refusal says: not "failed", not "skipped", but which fact is
       missing and who can supply it. The draft is built and priced; it is one confirmation
       away from going out. */
    return {
      send: false,
      reason:
        "the mail did not say monthly or annual, so the price is an assumption — the draft " +
        "is ready and priced; confirm the term and send it, or ask them which they want",
    };
  }

  return { send: true };
}
