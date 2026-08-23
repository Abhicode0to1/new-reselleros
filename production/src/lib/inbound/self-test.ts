/**
 * Letting the operator test the enquiry pipeline from their OWN address, without undoing
 * the guard that stops their own mail becoming leads by accident.
 *
 * ─── THE TWO THINGS THAT LOOK IDENTICAL ─────────────────────────────────────
 * `senderIsOurs` exists because of a real report on 22 Aug 2026 — "ye lead kyo bani" — when
 * a forwarded copy of our own mail turned into a lead named "anutech" with no seats and no
 * plan, sitting in New beside a genuine one. Echoes of our own sends do the same thing.
 * Both are ACCIDENTS: nobody meant those messages to enter the pipeline.
 *
 * A self-test is the opposite. The operator sits down, writes a mail from their own address
 * and wants it treated exactly as a customer's would be — that is the only way to see what
 * a customer would get. Same sender, opposite intent.
 *
 * Intent is not visible in an address, so it has to be stated. The marker is that
 * statement: a subject that STARTS with it is a deliberate act, and no accident produces
 * one. A forwarded thread carries the original subject; an echo of our own send carries the
 * subject we chose — and the auto-quote mail this feature exists to test is subjected
 * "Your quote Q-… — <tenant>", which does not begin with the marker. So the loop that would
 * otherwise be the real danger here cannot close.
 *
 * ─── WHY THE MARKER ALONE IS NOT ENOUGH ─────────────────────────────────────
 * `senderIsOurs` is still required. A stranger who happens to write "[selftest]" in a
 * subject line is not running a self-test — they are a customer with an odd subject, and
 * they must travel the ordinary path. Giving an outside address any privileged route
 * through a public webhook would be a hole, not a feature; the marker widens what OUR
 * addresses may do and nothing else.
 *
 * ─── WHAT IT COSTS, AND IT IS NOT NOTHING ───────────────────────────────────
 * A self-test produces a REAL lead, and if the mail names a product, a seat count and a
 * term, a REAL quote — which takes an irreversible number from the gapless CGST Rule 46
 * series. That number cannot be handed back. The lead is marked `email-selftest` at source
 * so it can be found and deleted afterwards; the document number cannot be, and the caller
 * says so on the record rather than letting it be discovered at audit time.
 */

/** Case-insensitive, and it has to be at the START of the subject. */
export const SELF_TEST_MARKER = "[selftest]";

export interface SelfTestInput {
  /** Only our own addresses may use the marker — see the header. */
  senderIsOurs: boolean;
  subject: string | null | undefined;
}

export function isSelfTest(input: SelfTestInput): boolean {
  if (!input.senderIsOurs) return false;
  const s = (input.subject ?? "").trim().toLowerCase();
  /* startsWith, not includes. "Re: Fwd: [selftest] …" is a thread ABOUT a test, not a test
     — the reply prefixes are exactly the trail an accidental forward leaves, and treating
     one as deliberate would reopen the hole this guards. */
  return s.startsWith(SELF_TEST_MARKER);
}
