/**
 * Reading a mailbox through the Gmail API, and turning a message into the shape the
 * inbound pipeline already understands.
 *
 * ─── WHAT THIS REPLACES ─────────────────────────────────────────────────────
 * An Apps Script running inside Gmail on a 5-minute timer, which searched for mail, POSTed
 * each message to /api/webhooks/inbound-email with a shared secret, and labelled the thread
 * `erp-sent` so it would not send it twice.
 *
 * On 30 Aug 2026 that chain was found broken at its quietest link. A stale copy of the
 * script was posting an old `?key=` secret matching nothing Cloud Run accepts; every run
 * returned 401; the mail was labelled anyway by that older code, so it looked delivered
 * from inside Gmail; and no enquiry reached the app for two days. The only trace was an
 * execution log in a Google account nobody opens.
 *
 * The payload built here is deliberately IDENTICAL to what that script sent, field for
 * field, including `messageId: <gmail message id>`. Nothing downstream changes, and the
 * webhook stays available for a second reseller's inbound-parse provider.
 *
 * ─── NO WRITES, ON PURPOSE ──────────────────────────────────────────────────
 * Every function here reads. The scope is `gmail.readonly`, which cannot label, archive or
 * delete. The forwarder needed to write because a label WAS its memory; this remembers in
 * `inbound_emails.message_id`, which is UNIQUE, so a message already ingested is skipped by
 * the database rather than by a mailbox flag only one script can see.
 */
import "server-only";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Google is usually quick, and a cron must not be held open by one hung call. */
const TIMEOUT_MS = 15_000;

export interface GmailHeaderPair { name?: string; value?: string }

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  internalDate?: string;
  payload?: GmailPart & { headers?: GmailHeaderPair[] };
}

/* ── Pure parsing, exported so it can be tested without a network ──────────── */

/** Headers as a case-insensitive lookup. Header names are case-insensitive per RFC 5322. */
export function headerMap(msg: GmailMessage | null | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of msg?.payload?.headers ?? []) {
    if (h.name) m.set(h.name.toLowerCase(), h.value ?? "");
  }
  return m;
}

/**
 * The readable body.
 *
 * ─── WHY IT WALKS THE TREE AND PREFERS text/plain ───────────────────────────
 * A Gmail message is a MIME tree. A simple mail has its text at `payload.body.data`; a
 * normal reply from any modern client is `multipart/alternative` with text/plain and
 * text/html siblings; a mail with an attachment wraps that whole thing in
 * `multipart/mixed`. Reading only the top level returns an empty string for most real mail.
 *
 * text/plain is preferred because the extractor downstream reads prose — seat counts,
 * product names, phone numbers — and HTML would feed it tags. text/html is stripped and
 * used only when there is no plain part at all, which is what the enquiries list already
 * does for the same reason.
 *
 * Attachment parts are skipped by `filename`: an attached .txt has a text/plain mimeType
 * and is not the message.
 */
export function plainTextFromPayload(part: GmailPart | undefined | null): string {
  const plain: string[] = [];
  const html: string[] = [];

  const walk = (p: GmailPart | undefined | null, depth: number): void => {
    /* Bounded: a malformed or hostile message must not recurse forever. Ten is far deeper
       than any real mail — multipart/mixed → alternative → related is three. */
    if (!p || depth > 10) return;
    const mime = (p.mimeType ?? "").toLowerCase();
    const isAttachment = Boolean(p.filename && p.filename.trim());
    if (!isAttachment && p.body?.data) {
      if (mime.startsWith("text/plain")) plain.push(decodeB64Url(p.body.data));
      else if (mime.startsWith("text/html")) html.push(decodeB64Url(p.body.data));
    }
    for (const c of p.parts ?? []) walk(c, depth + 1);
  };
  walk(part, 0);

  if (plain.length) return plain.join("\n").trim();
  if (html.length) {
    return html.join("\n")
      /* Blocks become line breaks before tags are dropped, otherwise every paragraph runs
         into the next and "40 seats" can end up glued to the signature. */
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
      .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }
  return "";
}

/** Gmail returns base64url, and `Buffer` needs to be told. */
function decodeB64Url(data: string): string {
  try { return Buffer.from(data, "base64url").toString("utf8"); }
  catch { return ""; }
}

export interface IngestPayload {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
}

/**
 * A Gmail message in the exact shape the pipeline already parses.
 *
 * `messageId` is Gmail's own message id — the SAME value the Apps Script sent, so a mail
 * ingested by the old forwarder and re-read by this one de-duplicates against the existing
 * row instead of arriving twice. That is the single most important line in this file, and
 * it is why the cutover needs no migration and no cleanup.
 *
 * The RFC `Message-Id` header is deliberately NOT used for that: it is chosen by the
 * sender, so two different mails can carry the same one, and `inbound_emails.message_id`
 * is UNIQUE per tenant — a collision would silently swallow a real enquiry.
 */
export function toIngestPayload(msg: GmailMessage, maxChars = 8000): IngestPayload {
  const h = headerMap(msg);
  return {
    from:    h.get("from") ?? "",
    to:      h.get("to") ?? "",
    subject: h.get("subject") ?? "",
    text:    plainTextFromPayload(msg.payload).slice(0, maxChars),
    messageId: msg.id,
    inReplyTo:  h.get("in-reply-to") || undefined,
    references: h.get("references") || undefined,
  };
}

/* ── Network ───────────────────────────────────────────────────────────────── */

async function api<T>(token: string, path: string): Promise<T> {
  const r = await fetch(`${API}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    /* Same reason every other Google call here does it: a cached list would report an
       inbox that has not changed since the last run, which is the exact bug this whole
       feature exists to end. */
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`gmail ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<T>;
}

/**
 * Ids of recent messages, newest first.
 *
 * ─── WHY A TIME WINDOW AND NOT A CURSOR ─────────────────────────────────────
 * A cursor (Gmail's historyId) reads less, but it has one failure mode this system cannot
 * afford: if the stored cursor is ever lost or overtaken, the mail between it and now is
 * skipped in silence. A time window re-lists the same handful of ids every run and the
 * database throws all but the new ones away. Re-reading is cheap; a silent gap is what put
 * this feature on the roadmap.
 *
 * The default window is generous for the same reason. At a one-minute cadence a two-day
 * window means the cron can be down for a day and a half and still lose nothing.
 */
export async function listRecentMessageIds(
  token: string,
  opts: { query?: string; max?: number } = {},
): Promise<string[]> {
  const q = opts.query ?? DEFAULT_QUERY;
  const r = await api<{ messages?: { id: string }[] }>(
    token, `messages?q=${encodeURIComponent(q)}&maxResults=${opts.max ?? 50}`);
  return (r.messages ?? []).map((m) => m.id);
}

/**
 * What counts as an enquiry to look at.
 *
 * `-in:sent` earns its place: this reads the mailbox the app also SENDS from, and without
 * it every quote the app mails out comes straight back in as an enquiry from ourselves.
 * `-in:chats` and `-in:draft` are the other two things Gmail's search returns that are not
 * received mail. Spam and Trash are already excluded by Gmail unless asked for.
 */
export const DEFAULT_QUERY = "newer_than:2d -in:sent -in:chats -in:draft";

export async function fetchMessage(token: string, id: string): Promise<GmailMessage> {
  return api<GmailMessage>(token, `messages/${id}?format=full`);
}
