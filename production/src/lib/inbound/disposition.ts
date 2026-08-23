/**
 * What to do with an inbound email: file it on a conversation we already have, treat
 * it as a new enquiry, or set it aside as non-sales mail.
 *
 * ─── THE BUG THIS EXISTS TO FIX ─────────────────────────────────────────────
 * Reported 22 Aug 2026: "kafi time ho gaya message aaye abhi tak show nahi ho raha."
 * The message had arrived — three minutes before, with fifteen more in the preceding
 * two hours. It was in the database with status `skipped_non_enquiry`, which
 * `lib/inbound/folders.ts` files under **Spam / System**, out of the Inbox.
 *
 * `api/webhooks/inbound-email/route.ts` asked its two questions in the wrong order:
 *
 *     line 431   if (!extracted.isEnquiry) -> skipped_non_enquiry, stop
 *     line 445   is there an open lead with this sender? -> append to it
 *
 * The skip came FIRST. So Gemini was handed a mid-thread reply and asked "is this a
 * sales enquiry?", and answered no — which is *correct*. A reply saying "actually I
 * need 20 users of Standard, not 50 of Starter" is not a new enquiry. It is the most
 * important message in the thread. It went to Spam.
 *
 * ─── THE RULE ───────────────────────────────────────────────────────────────
 * A message from somebody we are already talking to is never spam. We know who they
 * are and what it is about, so there is nothing for a classifier to decide. The
 * classifier's job is triaging mail from STRANGERS — that is the only case where
 * "is this a sales enquiry or a newsletter" is an open question.
 *
 * So: match against an open lead first; only ask the model when nobody matches.
 *
 * ─── AND AN UNAVAILABLE MODEL MUST NOT FILE MAIL AS SPAM ────────────────────
 * `isEnquiry: null` means Gemini did not run (no key, timeout, breaker open). That is
 * not a judgement and must not be treated as one. It resolves to `create`, so the
 * operator triages it — the route's own comment already reasons this way ("no AI →
 * don't silently drop; let the operator triage") and this keeps that true when the
 * decision moved out of the route.
 */

export type InboundDisposition =
  /** File on the existing lead. Its id is in `leadId`. */
  | { action: "append"; leadId: string; reason: string }
  /** Treat as a new enquiry and create a lead. */
  | { action: "create"; reason: string }
  /** Not sales mail from anyone we know. Filed under Spam / System. */
  | { action: "skip"; reason: string };

export interface DispositionInput {
  /**
   * An OPEN lead whose contact_email matches the sender, if one exists.
   * Won/lost leads are deliberately excluded by the caller: a reply on a closed deal
   * is a new conversation, not a continuation of a finished one.
   */
  openLeadId?: string | null;
  /**
   * The model's verdict. `null` means it did not run — an absence, not a "no".
   */
  isEnquiry?: boolean | null;
  /**
   * True when the sender is one of OUR OWN addresses — the tenant's contact address,
   * any of its users, or a connected Google account.
   *
   * ─── A REGRESSION I CAUSED, ON 23 AUG 2026 ────────────────────────────────
   * Every reply on a thread arrives TWICE: once as delivered to the customer-facing
   * address, and once as delivered to the address we send FROM, because that address is
   * in the thread. The second copy is our own outgoing mail coming back.
   *
   * Before the ordering fix those copies were classified "not an enquiry" and filed as
   * spam, which was wrong for the right reason. Then I made `isEnquiry: null` resolve to
   * `create` so a real first email could not vanish during a Gemini outage — and that
   * turned every echo of our own mail into a NEW LEAD. Measured within the hour: a lead
   * named "anutech" (from the domain fallback), no seats, no plan, sitting in New beside
   * the real one.
   *
   * So this is checked before anything else. Our own address is never a customer.
   */
  senderIsOurs?: boolean;
}

export function decideDisposition(input: DispositionInput): InboundDisposition {
  /* FIRST, ahead of even the known-lead check. An echo of our own message must not be
     filed onto the conversation either — it would duplicate the thread with a copy of
     something already recorded as sent. */
  if (input.senderIsOurs) {
    return {
      action: "skip",
      reason: "sent from one of our own addresses — this is a copy of mail we sent, not an enquiry",
    };
  }

  const leadId = (input.openLeadId ?? "").trim();

  /* Asked FIRST, and this ordering IS the fix. Note what is NOT consulted here:
     `isEnquiry`. Somebody mid-conversation with us does not get their reply graded. */
  if (leadId) {
    return {
      action: "append",
      leadId,
      reason: "reply from a contact with an open lead — filed on that conversation",
    };
  }

  if (input.isEnquiry === null || input.isEnquiry === undefined) {
    return {
      action: "create",
      reason: "no classification available (AI did not run) — surfaced for the operator rather than filed away",
    };
  }

  return input.isEnquiry
    ? { action: "create", reason: "new enquiry from an unknown sender" }
    : { action: "skip",   reason: "not a sales enquiry, and no open conversation with this sender" };
}
