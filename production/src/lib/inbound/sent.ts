/**
 * Replies we sent, kept in the same table as the mail they answer.
 *
 * ─── THE COMPLAINT THIS ANSWERS ─────────────────────────────────────────────
 * *"mene enquiry ko reply bhi send kiya par kaise pata chalega ki kya reply send kiya
 * hai"* — the screen said "You already replied to this on 18 Aug 2026" and stopped there.
 * It could not show the text, because the send only wrote to `email_log`, which records
 * recipient, subject and delivery status and NO body. The Sent folder was therefore a
 * label over an empty room.
 *
 * That was my call and it was wrong for a mail client. Knowing THAT you replied is not
 * the useful fact; knowing WHAT you said is, because the next thing a rep does is either
 * follow up on it or repeat it.
 *
 * ─── WHY A ROW IN inbound_emails AND NOT A NEW TABLE ────────────────────────
 * A sent reply and the enquiry it answers are the same conversation, and the thread
 * grouping, the search, the folders and the reading pane are already built over this
 * table. A separate table would need every one of them written twice, and the two copies
 * would drift — which is how the folder list and the search box end up disagreeing about
 * the same mail.
 *
 * It also needs no schema change. `status` is free text and `route` already accepts
 * 'sales', which is what this is. Nothing new to migrate, so nothing to go wrong between
 * git and production — this repo has that history.
 *
 * ─── THE DIRECTION IS READ FROM WHO IT IS ADDRESSED TO ──────────────────────
 * An inbound mail has a `from_email` and the sender is the customer. A reply has
 * `from_email = null` and a `to_email`, because it left from the tenant's own connected
 * account, whose address belongs to the tenant and not to this row. `status` carries the
 * marker so no folder rule has to infer direction from a null.
 */
import type { InboundEmailRow } from "@/lib/supabase/database.types";

/**
 * `inbound_emails.status` on a reply we sent.
 *
 * A distinct value, not "sent" — that word already means a delivery outcome in
 * `email_log`, and two meanings for one word in one codebase is a bug waiting for a
 * quiet afternoon.
 */
export const SENT_REPLY_STATUS = "reply_sent";

/** The subset the rules read. Structural so tests need no database row. */
export type SentRow = Pick<InboundEmailRow, "status">;

export function isSentReply(row: SentRow): boolean {
  return row.status === SENT_REPLY_STATUS;
}

/**
 * What the reading pane shows above a sent reply.
 *
 * States the address it LEFT FROM, and that is the whole point of the line. Pardeep sent
 * a reply and then looked for it in sales@anutech.in, where it was never going to be: the
 * connected Google account is pardeep@anutech.in, so the copy is in that account's Sent
 * folder and the reply itself went to the customer. A screen that shows only "replied"
 * leaves the operator hunting the wrong mailbox.
 */
export function sentFromNote(senderEmail: string | null | undefined): string {
  const from = (senderEmail ?? "").trim();
  return from
    ? `Sent from ${from} — the copy is in that account's Sent folder, not in your enquiry inbox.`
    /* No connected account known. Says so rather than naming a likely address: a wrong
       mailbox to search in is worse than being told to check the settings. */
    : "Sent from your connected email account. Open Settings → Email to see which address that is.";
}
