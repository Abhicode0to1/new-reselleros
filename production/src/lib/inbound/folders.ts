/**
 * The folders a salesperson understands, over the states the system actually stores.
 *
 * ─── WHY THE OLD NAMES HAD TO GO ────────────────────────────────────────────
 * The page used to offer `untriaged`, `appended` and `skipped`. Those are the
 * webhook's words for what IT did — they describe the pipeline, not the rep's day.
 * "Appended" tells a salesperson nothing about whether they owe someone a reply.
 *
 * ─── TWO KINDS OF STATE, KEPT APART ─────────────────────────────────────────
 * `status` is what the SYSTEM did (received / lead_created / skipped_non_enquiry…).
 * `starred`, `read_at`, `snoozed_until`, `archived_at` are what a PERSON did. They
 * move independently — an email can be `lead_created` and still unread and starred —
 * so folders that mixed them would have to change a pipeline value to flag a mail,
 * and every report reading `status` would then be wrong.
 *
 * ─── SNOOZED IS NOT ARCHIVED ────────────────────────────────────────────────
 * A snoozed email leaves the Inbox and COMES BACK when its moment passes. That is
 * the entire promise of snoozing, and it is why `snoozed_until` is compared to now
 * on every read rather than being flipped by a job that might not run.
 */
import type { InboundEmailRow } from "@/lib/supabase/database.types";

export type MailFolder =
  | "inbox" | "starred" | "snoozed" | "leads" | "sent" | "done" | "spam";

export interface FolderMeta {
  id:    MailFolder;
  label: string;
  icon:  string;
  /** One line of plain English, shown when the folder is empty. */
  hint:  string;
}

export const MAIL_FOLDERS: readonly FolderMeta[] = [
  { id: "inbox",   label: "Inbox",           icon: "📥", hint: "New enquiries waiting on you." },
  { id: "starred", label: "Starred",         icon: "⭐", hint: "Nothing flagged yet — star an enquiry to keep it here." },
  { id: "snoozed", label: "Snoozed",         icon: "⏰", hint: "Nothing put off. Snoozed mail comes back to the Inbox on its own." },
  { id: "leads",   label: "Converted Leads", icon: "🎯", hint: "Enquiries that became a lead will collect here." },
  { id: "sent",    label: "Sent",            icon: "📤", hint: "Replies you send from here will be listed." },
  { id: "done",    label: "Done",            icon: "✅", hint: "Nothing archived yet. Finished enquiries land here — nothing is ever deleted." },
  { id: "spam",    label: "Spam / System",   icon: "🚫", hint: "Automated and non-sales mail is filed here, out of the Inbox." },
] as const;

/** The subset of a row the folder rules read. Structural so tests need no DB row. */
export type FoldersRow = Pick<
  InboundEmailRow, "status" | "lead_id"
> & {
  starred:       boolean | null;
  snoozed_until: string | null;
  archived_at:   string | null;
};

/**
 * Statuses that mean "the system decided this is not a sales enquiry".
 *
 * `error` is deliberately NOT here. A mail the pipeline choked on is exactly the one
 * a human should see — hiding it in Spam is how a real enquiry disappears because a
 * parser threw.
 */
const SPAM_STATUSES = new Set(["skipped_non_enquiry", "duplicate"]);

export function isSpam(row: FoldersRow): boolean {
  return SPAM_STATUSES.has(row.status);
}

/** Is this email currently hidden by a snooze? */
export function isSnoozed(row: FoldersRow, nowISO: string): boolean {
  return row.snoozed_until != null && row.snoozed_until > nowISO;
}

/**
 * Does this email belong in that folder right now?
 *
 * Folders OVERLAP on purpose, the way Gmail's labels do: a starred enquiry that has
 * become a lead shows in Inbox, Starred and Converted Leads. Making them exclusive
 * would mean starring something removed it from the Inbox, which is the opposite of
 * what a flag is for.
 */
export function inFolder(row: FoldersRow, folder: MailFolder, nowISO: string): boolean {
  const archived = row.archived_at != null;

  switch (folder) {
    case "inbox":
      /* Everything a rep still owes an answer on. Archived, snoozed and system mail
         are the three things that have already been dealt with or were never work. */
      return !archived && !isSnoozed(row, nowISO) && !isSpam(row);

    case "starred":
      /* Shows wherever the mail lives — including archived. A flag that vanished
         when you filed the mail would not be a flag. */
      return row.starred === true;

    case "snoozed":
      return isSnoozed(row, nowISO);

    case "leads":
      return row.lead_id != null;

    case "done":
      return archived;

    case "spam":
      return isSpam(row);

    case "sent":
      /* Sent mail is not in this table at all — it lives in `email_log`, which
         records recipient, subject and delivery status but NO body. The page loads
         that folder separately and says so; returning false here keeps the rule
         honest instead of quietly showing an empty list of inbound mail. */
      return false;
  }
}

/** How many rows are in each folder — the numbers beside the folder names. */
export function folderCounts(
  rows: readonly FoldersRow[],
  nowISO: string,
): Record<MailFolder, number> {
  const counts = {
    inbox: 0, starred: 0, snoozed: 0, leads: 0, sent: 0, done: 0, spam: 0,
  } as Record<MailFolder, number>;
  for (const row of rows) {
    for (const f of MAIL_FOLDERS) {
      if (inFolder(row, f.id, nowISO)) counts[f.id] += 1;
    }
  }
  return counts;
}

/**
 * Unread count for the Inbox badge.
 *
 * Only the Inbox gets one. Gmail shows unread counts per folder, but a rep acting on
 * "12 unread" needs that to mean twelve things to do — counting unread mail that is
 * archived or snoozed inflates it with work already handled.
 */
export function inboxUnread(
  rows: readonly (FoldersRow & { read_at: string | null })[],
  nowISO: string,
): number {
  return rows.filter((r) => r.read_at == null && inFolder(r, "inbox", nowISO)).length;
}
