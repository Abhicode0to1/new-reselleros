/**
 * Keyset-pagination helpers shared by the paged list hooks (S37, 28 Sep 2026).
 *
 * Pure — no React, no Supabase — so the rules that decide "which rows are on screen" are
 * tested in keyset.test.ts rather than trusted.
 *
 * Keyset, not OFFSET: the cursor is the (sort key, id) of the LAST row served, and the
 * next page is "strictly after it" in one total order. Rows arriving while somebody pages
 * land on page 1 and never shift later pages, so paging cannot repeat or skip a row.
 */

/**
 * Flatten loaded pages into one list, first occurrence wins. Keyset pages cannot overlap,
 * but a poll refetches page 1 on its own schedule and it can momentarily hold a row that a
 * later (older) page also still holds — dropping the repeat stops a row rendering twice.
 */
export function flattenPages<T>(pages: readonly { rows: readonly T[] }[] | undefined, key: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const p of pages ?? []) {
    for (const r of p.rows) {
      const k = key(r);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

// ── Inbox (GET /api/inbound-emails) ──────────────────────────────────────────

/** The inbox cursor: the last row's created_at EXACTLY as Postgres returned it, and its id. */
export interface InboxCursor {
  created_at: string;
  id: string;
}

/** Response header carrying the next page's cursor as JSON; absent on the last page. The
 *  body stays a bare array so the existing single-page reader is unchanged. */
export const INBOX_NEXT_CURSOR_HEADER = "x-next-cursor";

/**
 * Read `?before=<created_at>&before_id=<uuid>` into a cursor. Both or neither — half a
 * cursor is refused (null + error) rather than treated as "first page", which would repeat
 * page 1 forever for a client with a bug.
 */
export function parseInboxCursor(params: URLSearchParams): { cursor: InboxCursor | null; error: string | null } {
  const at = params.get("before");
  const id = params.get("before_id");
  if (!at && !id) return { cursor: null, error: null };
  if (!at || !id) return { cursor: null, error: "Pass both before and before_id (the next cursor exactly as it was returned), or neither for the first page." };
  /* ISO shape as Postgres returns it — Date() alone also accepts "Sep 28 2026 (anything)". */
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/.test(at) || Number.isNaN(new Date(at).getTime())) {
    return { cursor: null, error: "before is not a timestamp." };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return { cursor: null, error: "before_id is not an id." };
  return { cursor: { created_at: at, id }, error: null };
}

/** The query string for the page after `cursor`. */
export function inboxCursorQuery(cursor: InboxCursor | null): string {
  if (!cursor) return "";
  const p = new URLSearchParams({ before: cursor.created_at, before_id: cursor.id });
  return `?${p.toString()}`;
}

/**
 * PostgREST `or=` filter for "strictly older than the cursor" in (created_at desc, id desc):
 *   created_at < c  OR  (created_at = c AND id < c.id)
 *
 * The timestamp is double-quoted: it carries `:` and `+`, and PostgREST reads an unquoted
 * `,` `(` `)` as syntax. It is passed through AS RETURNED — rounding it to milliseconds via
 * Date would drop the microseconds and silently skip rows that share the same millisecond.
 */
export function inboxOlderThanFilter(cursor: InboxCursor): string {
  const at = `"${cursor.created_at.replace(/"/g, "")}"`;
  return `created_at.lt.${at},and(created_at.eq.${at},id.lt.${cursor.id})`;
}

/** Given the rows fetched with limit+1, the page to serve and the next cursor. */
export function pageFromOverfetch<T extends { created_at: string; id: string }>(
  rows: readonly T[], limit: number,
): { rows: T[]; next: InboxCursor | null } {
  if (rows.length <= limit) return { rows: [...rows], next: null };
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page, next: { created_at: last.created_at, id: last.id } };
}

/** Parse the next-cursor header; anything malformed is "no next page", never a throw. */
export function readInboxNextCursor(header: string | null): InboxCursor | null {
  if (!header) return null;
  try {
    const c = JSON.parse(header) as Partial<InboxCursor>;
    return typeof c.created_at === "string" && typeof c.id === "string" ? { created_at: c.created_at, id: c.id } : null;
  } catch {
    return null;
  }
}
