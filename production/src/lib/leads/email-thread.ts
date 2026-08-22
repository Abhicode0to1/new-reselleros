/**
 * The email exchange on one lead, assembled as a thread.
 *
 * ─── WHY THIS IS ASSEMBLY AND NOT STORAGE ───────────────────────────────────
 * Nothing new is stored. `inbound_emails` already holds both directions — see
 * `lib/inbound/sent.ts`, which explains why a reply lives in the same table as the mail it
 * answers rather than in a table of its own. An inbound message carries `from_email` (the
 * customer); a reply we sent carries `to_email` with `from_email = null` and
 * `status = 'reply_sent'`.
 *
 * So the data for a two-sided thread has existed all along; what was missing was a view
 * that showed it as one. The Conversation tab mixed email in with calls, quotes and tasks,
 * and the reported symptom was Pardeep asking where a reply from the lead's address would
 * even appear.
 *
 * ─── DIRECTION IS READ, NEVER GUESSED ───────────────────────────────────────
 * `isSentReply` is the shared test, imported rather than re-derived. Reading direction from
 * "is from_email null" would work today and break the first time an inbound row arrives
 * without a sender — and `lib/inbound/sent.ts` says exactly why the marker exists instead.
 */
import type { InboundEmailRow } from "@/lib/supabase/database.types";
import { isSentReply } from "@/lib/inbound/sent";

export type EmailDirection = "inbound" | "outbound";

export interface ThreadMessage {
  id: string;
  direction: EmailDirection;
  /** Who it came from (inbound) or went to (outbound). Null when the row has neither. */
  counterparty: string | null;
  subject: string | null;
  /**
   * The plain-text body, and ONLY the plain-text body.
   *
   * `body_html` is deliberately never returned. It is attacker-controlled text — anyone
   * can email this address — so putting it on screen means rendering a stranger's markup
   * inside the operator's session. Plain text cannot do that. A message that arrived with
   * html only reports `htmlOnly` instead, and the panel says so rather than showing an
   * empty bubble.
   */
  body: string | null;
  /** True when the message has html but no plain text, so `body` is null for a reason. */
  htmlOnly: boolean;
  /** ISO timestamp. Used for ordering and display. */
  at: string | null;
}

/** The columns this module reads. Structural, so tests need no database row. */
export type ThreadRow = Pick<
  InboundEmailRow,
  "id" | "lead_id" | "status" | "from_email" | "to_email" | "subject" | "body_text" | "body_html" | "created_at"
>;

/**
 * Every email on this lead, oldest first.
 *
 * Oldest-first because a thread is read as a conversation, not as an inbox. The activity
 * timeline beside it is newest-first, and that difference is deliberate: one answers "what
 * happened last", this one answers "how did this exchange go".
 *
 * Rows with no `lead_id` match are dropped rather than guessed at by address. Threading on
 * a matching email string would merge two leads that share an info@ address, and merging
 * two customers' correspondence is not a display bug.
 */
export function buildEmailThread(rows: readonly ThreadRow[], leadId: string | null | undefined): ThreadMessage[] {
  if (!leadId) return [];

  return rows
    .filter((r) => r.lead_id === leadId)
    .map((r): ThreadMessage => {
      const outbound = isSentReply(r);
      const text = r.body_text?.trim() ? r.body_text : null;
      return {
        id: r.id,
        direction: outbound ? "outbound" : "inbound",
        counterparty: (outbound ? r.to_email : r.from_email) ?? null,
        subject: r.subject ?? null,
        body: text,
        htmlOnly: text === null && Boolean(r.body_html?.trim()),
        at: r.created_at ?? null,
      };
    })
    /* Ties broken by id so the order is stable across renders. Two messages can share a
       timestamp — a reply written the same second it was logged — and a thread that
       reshuffles on every refetch reads as data changing under you. */
    .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "") || a.id.localeCompare(b.id));
}

export interface ThreadSummary {
  total: number;
  inbound: number;
  outbound: number;
  /** True when the customer has never written — the case the Email button cannot thread into. */
  awaitingFirstInbound: boolean;
  /** The newest message, for the tab badge and the "last activity" line. */
  latest: ThreadMessage | null;
  /**
   * The customer has written back since we last wrote — so anything the LEAD row
   * records about what they want is a snapshot that their newest message may have
   * overtaken.
   *
   * Needed by the reply pills: on 22 Aug 2026 the quote pill restated "50 users of
   * Business Starter" to a customer whose reply had just changed it to 20 of
   * Standard. Both halves matter — an inbound newest message is not enough on its
   * own, because a FIRST enquiry is also inbound-newest and there the stored facts
   * are exactly right to repeat back.
   */
  customerRepliedToUs: boolean;
}

export function summariseThread(thread: readonly ThreadMessage[]): ThreadSummary {
  const inbound = thread.filter((m) => m.direction === "inbound").length;
  return {
    total: thread.length,
    inbound,
    outbound: thread.length - inbound,
    awaitingFirstInbound: inbound === 0,
    customerRepliedToUs:
      thread.length > 0 &&
      thread[thread.length - 1].direction === "inbound" &&
      thread.length - inbound > 0,
    latest: thread.length > 0 ? thread[thread.length - 1] : null,
  };
}
