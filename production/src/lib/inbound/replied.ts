/**
 * Has this enquiry already been REPLIED to?
 *
 * ─── THE SAME FAILURE AS answered.ts, ONE STEP EARLIER ──────────────────────
 * `answered.ts` catches the expensive version: a second quote for one request. This
 * catches the cheap, far more frequent one — two people (or the same person twice) typing
 * "thanks, quote on its way" to the same customer, because the screen said nothing about
 * the first.
 *
 * ─── DERIVED FROM email_log, NOT FROM A FLAG ────────────────────────────────
 * There is no `replied_at` column and this deliberately does not add one. A flag written by
 * the app is a second source of truth that can disagree with whether an email actually
 * left; email_log is written from inside sendEmail() (see lib/email/log.ts) and records the
 * outcome the provider reported. Deriving from it means the screen cannot claim a reply
 * that never went.
 *
 * ─── AND A "STUBBED" SEND IS NOT A REPLY ────────────────────────────────────
 * When no mail provider is configured, sendEmail returns `stubbed` and nothing leaves. The
 * row still lands in email_log — correctly, the attempt happened — but counting it as a
 * reply would tell a reseller their customer has been answered when their customer has
 * heard nothing. Only `sent` counts.
 *
 * ─── A REPLY FROM BEFORE THE EMAIL IS NOT A REPLY TO IT ─────────────────────
 * Same rule as answered.ts. Mail sent to this address last month is history; the caller
 * filters by recipient and this filters by time.
 */

export interface ReplyRef {
  /** ISO instant the send was recorded. */
  sentAt: string;
  /** What lib/email/send.ts returned: "sent" | "stubbed" | "failed". */
  status: string;
  subject?: string | null;
}

export type RepliedState =
  /** At least one reply actually left after this email arrived. */
  | { kind: "replied"; last: ReplyRef; count: number }
  /**
   * Attempts were made but NONE of them left — no provider configured, or every send
   * failed. Reported apart from "replied" because the customer is still waiting and the
   * operator has no way to know that from a green tick.
   */
  | { kind: "attempted-only"; last: ReplyRef; count: number }
  | { kind: "none" };

export function repliedState(
  emailReceivedAt: string,
  replies: readonly ReplyRef[],
): RepliedState {
  const received = Date.parse(emailReceivedAt);
  /* `>=`, like answered.ts: a reply typed straight from the reading pane can land in the
     same second the email is recorded. */
  const after = [...replies]
    .filter((r) => Date.parse(r.sentAt) >= received)
    .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));

  if (after.length === 0) return { kind: "none" };

  const delivered = after.filter((r) => r.status === "sent");
  if (delivered.length > 0) {
    return { kind: "replied", last: delivered[0], count: delivered.length };
  }
  return { kind: "attempted-only", last: after[0], count: after.length };
}

/**
 * The sentence above the composer.
 *
 * `when` formats the instant — passed in rather than imported so this stays a pure
 * function and the page keeps using its own formatDate.
 */
export function repliedNote(state: RepliedState, when: (iso: string) => string): string | null {
  switch (state.kind) {
    case "replied":
      return state.count === 1
        ? `You already replied to this on ${when(state.last.sentAt)}.`
        : `You have replied to this ${state.count} times — the last on ${when(state.last.sentAt)}.`;
    case "attempted-only":
      /* Deliberately not "you replied". Nothing reached the customer. */
      return `A reply was written on ${when(state.last.sentAt)} but it did not go out. The customer has not heard from you — send it again.`;
    case "none":
      return null;
  }
}

/** Whether the note is a warning (amber) or plain information. */
export function repliedIsProblem(state: RepliedState): boolean {
  return state.kind === "attempted-only";
}
