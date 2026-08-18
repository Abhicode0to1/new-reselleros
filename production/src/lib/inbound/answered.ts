/**
 * Has this enquiry already been answered with a quote?
 *
 * ─── THE FAILURE THIS PREVENTS ──────────────────────────────────────────────
 * Pardeep sent a quote from an enquiry, came back to the screen later, and it looked
 * exactly as it had before — nothing said the work was done. His words: *"mujhe yaad nahi
 * raha to me dobara quote bhej dunga, ye to galat hoga."* He is right, and the cost lands
 * on the customer: two quotes for one request, possibly at different prices, and a
 * conversation that now starts with "which one is correct?".
 *
 * ─── AND "MARK DONE" IS NOT THE ANSWER, IT IS THE THING THAT FAILED ─────────
 * The screen already has a Mark done button. It depends on the operator remembering to
 * press it in the same breath as doing the work — which is precisely the memory that just
 * failed. A state that has to be maintained by hand disagrees with reality on exactly the
 * day it matters.
 *
 * So this is DERIVED. The quotes table already knows a quote went out against this lead;
 * the screen simply never asked. Same rule as the qualification checklist on /leads: a
 * checkbox that disagrees with its data is the one the rep believes.
 *
 * ─── A QUOTE FROM BEFORE THE EMAIL IS NOT A REPLY TO IT ─────────────────────
 * The distinction that makes this useful rather than noisy. A customer who was quoted last
 * month and has now emailed "send me a quote" has NOT been answered — treating the old
 * quote as the reply would suppress the warning on the one enquiry that needs work.
 *
 * So a quote raised at or after the email arrived is an ANSWER; anything earlier is
 * CONTEXT, reported differently and never as "already done".
 */

export interface QuoteRef {
  id: string;
  /** ISO timestamp. */
  createdAt: string;
  /** ₹, whole rupees. */
  amount: number;
  status?: string | null;
}

export type AnsweredState =
  /** A quote went out after this email arrived. */
  | {
      kind: "answered";
      /** The newest one — the live answer. */
      quote: QuoteRef;
      /**
       * How many OTHER quotes also answer this email.
       *
       * More than zero means the duplicate already happened, and saying so is more use
       * than naming only the newest: the customer is holding two documents and the
       * operator needs to know which to stand behind. ANUTECH has exactly this —
       * Q-…-0010 and -0011, both Rs 1,34,138, fifteen minutes apart.
       */
      alsoAfter: number;
      /** Quotes predating the email — history, not answers. */
      alsoEarlier: number;
    }
  /** Quotes exist, but all predate this email — history, not a reply. */
  | { kind: "earlier-only"; latest: QuoteRef; count: number }
  /** Nothing has been quoted to this lead. */
  | { kind: "none" };

/**
 * Decide from the data.
 *
 * `quotes` should already be scoped to the enquiry's lead — this function does no
 * filtering by party, because a quote to the wrong customer must never be able to mark an
 * enquiry answered.
 */
export function answeredState(
  emailReceivedAt: string,
  quotes: readonly QuoteRef[],
): AnsweredState {
  if (quotes.length === 0) return { kind: "none" };

  const received = Date.parse(emailReceivedAt);
  const byNewest = [...quotes].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  /* `>=` not `>`: a quote raised in the same second as the email landed — which is what a
     fast operator working straight from the inbox produces — is the answer to it. */
  const after = byNewest.filter((q) => Date.parse(q.createdAt) >= received);

  if (after.length > 0) {
    return {
      kind: "answered", quote: after[0],
      alsoAfter: after.length - 1,
      alsoEarlier: quotes.length - after.length,
    };
  }
  return { kind: "earlier-only", latest: byNewest[0], count: quotes.length };
}

/**
 * The sentence the screen shows.
 *
 * States the quote NUMBER and the amount, not just "already quoted" — the operator's next
 * question is always "which one, and for how much", and making them go and look is how
 * they end up raising a second one anyway.
 */
export function answeredNote(
  state: AnsweredState,
  rupees: (n: number) => string,
  /**
   * How the quotes were tied to this enquiry, appended verbatim.
   *
   * Passed in rather than computed here because this function knows nothing about matching
   * — and because the caveat MUST be printed when the match rested on a customer name. A
   * warning that sounds certain when it is not is the kind people learn to ignore, and an
   * ignored warning is worse than none. See lib/inbound/quote-match.ts.
   */
  caveat = "",
): string | null {
  switch (state.kind) {
    case "answered": {
      /* Two answers to one email is not a footnote — it is the mistake this banner
         exists to prevent, already made. It leads. */
      if (state.alsoAfter > 0) {
        const total = state.alsoAfter + 1;
        return `You have already sent ${total} quotes for this enquiry — the latest is ${state.quote.id} for ${rupees(state.quote.amount)}. Check which one the customer should keep.${caveat}`;
      }
      const extra = state.alsoEarlier > 0
        ? ` There ${state.alsoEarlier === 1 ? "is 1 older quote" : `are ${state.alsoEarlier} older quotes`} as well.`
        : "";
      return `You already answered this — quote ${state.quote.id} for ${rupees(state.quote.amount)}.${extra}${caveat}`;
    }
    case "earlier-only":
      /* Deliberately NOT "already quoted". This customer has asked again and is waiting. */
      return `This customer was quoted before (${state.latest.id}, ${rupees(state.latest.amount)}), but that was BEFORE this email — they are asking again.${caveat}`;
    case "none":
      return null;
  }
}

/** What the primary button should say. Never "disabled" — see below. */
export function quoteButtonLabel(state: AnsweredState): string {
  return state.kind === "answered" ? "Send another quote" : "Send quote";
}

/**
 * Should sending be BLOCKED?
 *
 * No, and that is deliberate. Revising a quote is a normal, frequent act — the customer
 * changed the seat count, the price was renegotiated, the first one expired. Blocking it
 * would make the app wrong on a legitimate path in order to prevent a mistake that a
 * clearly-worded warning already prevents.
 *
 * Tell, do not forbid. The same reasoning as the "ready to quote" checklist on /leads,
 * which also informs and never refuses.
 */
export function blocksSending(_state: AnsweredState): boolean {
  return false;
}

/**
 * How the banner should LOOK, which is not the same question as what it says.
 *
 * A green tick beside "you have already sent 2 quotes — check which one the customer
 * should keep" reads as reassurance for a sentence that is reporting a mistake. The
 * operator scans the colour before the words, so the colour has to agree with them.
 *
 *   ok      — one quote, the work is done and nothing needs looking at
 *   problem — more than one quote answers this email; that is the duplicate itself
 *   warn    — quoted before, but BEFORE this email; the customer is asking again
 */
export type AnsweredTone = "ok" | "warn" | "problem";

export function answeredTone(state: AnsweredState): AnsweredTone {
  switch (state.kind) {
    case "answered":     return state.alsoAfter > 0 ? "problem" : "ok";
    case "earlier-only": return "warn";
    case "none":         return "ok";
  }
}
