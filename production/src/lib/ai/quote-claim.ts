/**
 * Did the draft tell the customer a quotation EXISTS?
 *
 * ─── THE MAIL THAT PROMPTED THIS ────────────────────────────────────────────
 * 30 Aug 2026, sent to a real address:
 *
 *   "Thank you for confirming. The quotation for 40 seats of Google Workspace Business
 *    Starter on monthly billing has been prepared at Rs 325 per seat per month, plus 18%
 *    GST, with our 3% volume discount applied."
 *
 * No such quotation existed. `quotes` held nothing for that lead — the product name in the
 * mail did not match the catalogue, so the auto-quote correctly refused, and the lead
 * recorded "No quote drafted automatically" three times. The agent never learned that, and
 * said the opposite to the customer, with a price in the same sentence.
 *
 * ─── WHY A GUARD AND NOT JUST A BETTER PROMPT ───────────────────────────────
 * The prompt already told it "No quotation has been sent yet" in the facts block, and it
 * still wrote that line — because a few lines further down the same prompt said: *"Say the
 * quotation has been prepared, and give its reference number if you were given one."* The
 * instruction is now conditional, which it should always have been.
 *
 * But a prompt is a request. Twice today an instruction alone was a coin toss — the seat
 * count reaching the model, and the word "discount" carrying its figure — and this one is
 * a factual claim about a document, made to a customer, next to a price. It gets the same
 * treatment as the money and promise guards: the draft is checked, and a claim that cannot
 * be true is not sent.
 *
 * ─── FUTURE TENSE IS FINE, AND THAT IS THE WHOLE DIFFICULTY ─────────────────
 * "I will prepare the quotation" is honest and useful; it is what the agent SHOULD say when
 * nothing exists yet. Only a claim that one already exists is refused. So the patterns below
 * are deliberately narrow, and every one of them is a completed act.
 */

/** Phrases that assert a quotation already exists. Each is a finished action. */
const CLAIMS: readonly RegExp[] = [
  /\bquotation\b[^.!?\n]{0,80}?\bhas been (?:prepared|created|drawn up|raised|issued)\b/i,
  /\bquote\b[^.!?\n]{0,80}?\bhas been (?:prepared|created|drawn up|raised|issued)\b/i,
  /\b(?:i|we)\s+have\s+(?:prepared|created|drawn up|raised|issued|attached)\b[^.!?\n]{0,60}?\bquot/i,
  /\bquotation\s+(?:is\s+)?(?:attached|enclosed|ready)\b/i,
  /\bquote\s+(?:is\s+)?(?:attached|enclosed|ready)\b/i,
  /\bplease find\b[^.!?\n]{0,40}?\bquot/i,
  /\bfind attached\b[^.!?\n]{0,40}?\bquot/i,
];

/**
 * The offending phrase, or null.
 *
 * Returns the matched text rather than a boolean so the reason written into the log and
 * shown to the operator quotes the draft's own words — "it says X" is checkable, "it made a
 * claim" is not.
 */
export function claimsQuoteExists(text: string | null | undefined): string | null {
  const s = (text ?? "").toString();
  if (!s.trim()) return null;
  for (const re of CLAIMS) {
    const m = re.exec(s);
    /* 140, not 90. At 90 the live sentence — "quotation for 40 seats of Google Workspace
       Business Starter on monthly billing has been prepared" — was cut one word before the
       verb, so the reason quoted the draft without quoting the part that was wrong. The
       patterns allow up to 80 characters between the noun and the verb, so the longest
       possible span is a little over a hundred; this fits it. */
    if (m) return m[0].trim().replace(/\s+/g, " ").slice(0, 140);
  }
  return null;
}

/**
 * Is this draft allowed to say a quotation exists?
 *
 * `quoteRef` is the lead's real quotation id. Present means the claim is true and the draft
 * may say so; null means nothing exists to refer to.
 */
export function unbackedQuoteClaim(
  text: string | null | undefined,
  quoteRef: string | null | undefined,
): string | null {
  if (quoteRef && quoteRef.trim()) return null;
  return claimsQuoteExists(text);
}
