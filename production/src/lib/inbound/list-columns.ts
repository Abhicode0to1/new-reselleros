/**
 * What GET /api/inbound-emails sends to the inbox list (S16, 28 Sep 2026).
 *
 * The inbox polls every 20s, and it used to `select("*")` — every body_html of every
 * email in the workspace, on every poll, in every open tab. HTML mail is routinely tens
 * of KB a message, and nothing on screen renders it: the page only ever uses body_html
 * as a tag-stripped FALLBACK when body_text is empty (enquiries/page.tsx snippet() and
 * the reading pane). So the list carries body_html only for exactly those rows.
 */
import type { InboundEmailRow } from "@/lib/supabase/database.types";

/** Every InboundEmailRow column except body_html. */
export const INBOX_LIST_COLUMNS =
  "id, tenant_id, message_id, from_email, from_name, to_email, route, subject, status, lead_id, ticket_id, attachment_path, attachment_name, attachment_mime, extracted_bill, bill_id, body_text, created_at, in_reply_to, thread_references, read_at, starred, snoozed_until, archived_at";

/**
 * A hard ceiling on one list response. The list used to be unbounded. The page derives
 * its folder counts and the lead drawer its per-lead thread from this same list, so a
 * small page size (50) would silently drop archived mail and older lead threads; this
 * bound is there so one workspace cannot pull an unbounded table every 20 seconds.
 */
export const INBOX_LIST_MAX_ROWS = 500;

/** Rows whose body_text is empty — the only ones the page would fall back to HTML for. */
export function idsNeedingHtml(rows: readonly { id: string; body_text: string | null }[]): string[] {
  return rows.filter((r) => !r.body_text?.trim()).map((r) => r.id);
}

/** Put body_html back on the rows that need it; null everywhere else. */
export function withHtmlFallback(
  rows: readonly Omit<InboundEmailRow, "body_html">[],
  html: readonly { id: string; body_html: string | null }[],
): InboundEmailRow[] {
  const byId = new Map(html.map((h) => [h.id, h.body_html]));
  return rows.map((r) => ({ ...r, body_html: byId.get(r.id) ?? null }));
}
