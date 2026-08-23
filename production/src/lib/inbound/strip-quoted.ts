/**
 * The part of an email the sender actually just wrote, with the quoted thread removed.
 *
 * ─── WHY THIS HAS TO EXIST BEFORE ANYTHING READS A REPLY ────────────────────
 * A reply carries the whole previous conversation underneath it. The message that
 * started this was, in full:
 *
 *     Actually, I need the quotation for 20 users of Google Workspace Business
 *     Standard, not 50 users of Starter. Please adjust that.
 *
 *     On Sat, 22 Aug 2026 at 21:54, <sales@anutech.in> wrote:
 *     > Hi test,
 *     > Thank you for your enquiry for 50 users of Google Workspace Business
 *     > Starter. I am preparing the quotation now...
 *
 * Both "20" and "50" are in that body, and so are both product names. Anything that
 * reads the raw text to learn what the customer wants — `lib/inbound/extract.ts`,
 * a model, a regex — is reading OUR OWN previous message as if the customer had just
 * said it. For Phase 1, which writes what it reads into the lead, that is not a
 * cosmetic problem: it would confidently overwrite 20 with 50 and cite the customer
 * as the source.
 *
 * ─── AND IT FAILS TOWARD EMPTY, NEVER TOWARD THE FULL TEXT ──────────────────
 * If stripping leaves nothing, this returns nothing. The tempting fallback — "if the
 * result looks empty, use the original" — puts the quoted thread straight back into
 * the one case where the parse went wrong, which is exactly when it is least safe.
 * An empty result means "no new text found", and the caller must treat that as
 * nothing-to-do rather than as licence to read everything.
 */

/**
 * Markers that begin a quoted block. Ordered by nothing in particular — the EARLIEST
 * match in the text wins, not the first in this list.
 *
 * `^>` is deliberately not here. A leading `>` marks a quoted LINE, not the start of
 * the block, and some clients quote without any header at all — that case is handled
 * separately below.
 */
const QUOTE_HEADERS: readonly RegExp[] = [
  /* Gmail / Apple Mail: "On <date> at <time>, <someone> wrote:". The date and name
     vary wildly by locale, so this matches the shape and not the content. Tolerates a
     line break inside, which Gmail inserts when the line is long. */
  /^[ \t]*On\b[\s\S]{0,200}?\bwrote:[ \t]*$/im,
  /* Outlook, English and the common localisations we see. */
  /^[ \t]*-{2,}\s*Original Message\s*-{2,}[ \t]*$/im,
  /^[ \t]*_{10,}[ \t]*$/m,
  /* Outlook's header block, which starts with From: and is followed by Sent:/Date:. */
  /^[ \t]*From:[^\n]*\n(?:[ \t]*(?:Sent|Date|To|Cc|Subject):[^\n]*\n){1,}/im,
  /* Zoho / Zimbra / some Indian hosts. */
  /^[ \t]*-{3,}\s*Forwarded message\s*-{3,}[ \t]*$/im,
  /* Services that ask you to keep your reply above a line. */
  /^[ \t]*#{3,}[^\n]*reply[^\n]*above[^\n]*$/im,
  /^[ \t]*-{3,}\s*Please (?:reply|type|write) above this line\s*-{3,}[ \t]*$/im,
];

export interface StripResult {
  /** What the sender wrote this time. Empty string when nothing could be isolated. */
  text: string;
  /** True when a quoted block was found and removed — useful for logs and tests. */
  removedQuote: boolean;
  /** Which marker cut it, for diagnosing a body that stripped badly. */
  marker: string | null;
}

export function stripQuoted(raw: string | null | undefined): StripResult {
  const body = (raw ?? "").replace(/\r\n/g, "\n");
  if (!body.trim()) return { text: "", removedQuote: false, marker: null };

  /* The earliest marker wins. Taking the first PATTERN to match instead would cut at an
     "Original Message" further down and keep a Gmail quote above it. */
  let cutAt = -1;
  let marker: string | null = null;
  for (const re of QUOTE_HEADERS) {
    const m = re.exec(body);
    if (m && m.index >= 0 && (cutAt === -1 || m.index < cutAt)) {
      cutAt = m.index;
      marker = m[0].split("\n")[0].trim().slice(0, 60);
    }
  }

  let head = cutAt === -1 ? body : body.slice(0, cutAt);

  /* Some clients quote with no header line at all — just `>` prefixes. Drop a trailing
     run of quoted lines. Only TRAILING: a `>` in the middle of fresh text is somebody
     quoting a phrase inline to answer it, and that is theirs, not ours. */
  const lines = head.split("\n");
  let end = lines.length;
  while (end > 0) {
    const l = lines[end - 1].trim();
    if (l === "" || l.startsWith(">")) { end--; continue; }
    break;
  }
  if (end < lines.length) {
    const dropped = lines.slice(end).some((l) => l.trim().startsWith(">"));
    if (dropped && marker === null) marker = "trailing quoted lines";
    head = lines.slice(0, end).join("\n");
  }

  const text = head.trim();
  return {
    text,
    removedQuote: cutAt !== -1 || marker === "trailing quoted lines",
    marker,
  };
}
