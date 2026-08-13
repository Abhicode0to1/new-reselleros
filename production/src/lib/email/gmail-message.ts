/**
 * Build an RFC 5322 message for the Gmail API.
 *
 * Resend takes a JSON body and constructs the message itself. Gmail's
 * `users.messages.send` takes a raw RFC 5322 message, base64url-encoded — so this
 * app has to assemble the MIME itself, and that shifts a class of bug onto us that
 * Resend was absorbing.
 *
 * ─── THE ONE THAT MATTERS: HEADER INJECTION ──────────────────────────────────
 * Headers are separated by CRLF. A value containing a newline therefore ends the
 * header and starts a new one, so a subject of
 *
 *     "Invoice ready\r\nBcc: attacker@example.com"
 *
 * silently adds a Bcc. Our subjects already carry customer-supplied text (company
 * names, quote titles, inbound email subjects echoed back), so this is reachable,
 * not theoretical. Every header value is stripped of CR and LF before use — there
 * is no legitimate newline inside a header value, so stripping loses nothing.
 *
 * ─── THE OTHER THINGS THAT SILENTLY CORRUPT MAIL ─────────────────────────────
 * • Line endings must be CRLF. A bare \n in the headers makes some servers treat
 *   the rest of the message as body, and the mail arrives with headers displayed
 *   as text.
 * • Non-ASCII in a header needs RFC 2047 encoding. "Renewal — Anutech" with an
 *   em dash arrives as mojibake otherwise, and Indian customer names routinely
 *   carry non-ASCII.
 * • Gmail wants base64URL (`-` and `_`, no padding), not standard base64. Standard
 *   base64 is rejected or mangled.
 */

export interface MimeAttachment {
  filename: string;
  content: Buffer | Uint8Array | string;
  contentType?: string;
}

export interface MimeInput {
  to: string;
  from: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  attachments?: MimeAttachment[];
}

const CRLF = "\r\n";

/**
 * Make a value safe to place in a header.
 *
 * Strips CR and LF — the injection vector — and collapses the resulting run of
 * whitespace so a stripped newline does not leave a gap that looks like a typo.
 */
export function sanitiseHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

/**
 * RFC 2047 encoded-word, applied only when the value is not plain ASCII.
 *
 * Encoding unconditionally would work but makes every header unreadable in logs
 * and in clients that show raw source, so it is applied only where needed.
 */
export function encodeHeaderValue(value: string): string {
  const safe = sanitiseHeaderValue(value);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(safe)) return safe;
  return `=?UTF-8?B?${Buffer.from(safe, "utf8").toString("base64")}?=`;
}

/**
 * An address header, e.g. `Anutech <billing@anutech.in>`.
 *
 * The display name is encoded if needed; the address itself is only sanitised,
 * never encoded — an encoded-word inside angle brackets is not a valid address.
 */
export function encodeAddressHeader(value: string): string {
  const safe = sanitiseHeaderValue(value);
  const m = /^(.*?)\s*<([^>]+)>$/.exec(safe);
  if (!m) return safe;
  const [, name, addr] = m;
  if (!name) return `<${addr}>`;
  return `${encodeHeaderValue(name)} <${addr.trim()}>`;
}

/** base64url, unpadded — what the Gmail API expects for `raw`. */
export function toBase64Url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Wrap base64 payloads at 76 characters, as RFC 2045 requires. */
function wrap76(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join(CRLF);
}

function boundary(seed: number): string {
  // Deterministic given the seed so the output is testable. Uniqueness only has
  // to hold within one message, and the seed is the message's own byte length.
  return `----=_ros_${seed.toString(36)}_${(seed * 2654435761 % 0xffffffff).toString(36)}`;
}

/**
 * Assemble the message.
 *
 * Structure follows what the content needs, rather than always using the most
 * general form: a multipart wrapper around a single text part makes some clients
 * show an empty message.
 *
 *   text only                      → text/plain
 *   text + html                    → multipart/alternative
 *   text (+ html) + attachments    → multipart/mixed wrapping the above
 */
export function buildMimeMessage(input: MimeInput): string {
  const headers: string[] = [
    `To: ${encodeAddressHeader(input.to)}`,
    `From: ${encodeAddressHeader(input.from)}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
  ];
  if (input.replyTo) headers.push(`Reply-To: ${encodeAddressHeader(input.replyTo)}`);
  headers.push("MIME-Version: 1.0");

  const attachments = input.attachments ?? [];
  const seed = input.text.length + input.subject.length + attachments.length;

  const textPart =
    `Content-Type: text/plain; charset="UTF-8"${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
    wrap76(Buffer.from(input.text, "utf8").toString("base64"));

  const htmlPart = input.html
    ? `Content-Type: text/html; charset="UTF-8"${CRLF}` +
      `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
      wrap76(Buffer.from(input.html, "utf8").toString("base64"))
    : null;

  // ── Body ────────────────────────────────────────────────────────────────
  let bodyHeaders: string;
  let body: string;

  if (attachments.length === 0 && !htmlPart) {
    bodyHeaders = `Content-Type: text/plain; charset="UTF-8"${CRLF}Content-Transfer-Encoding: base64`;
    body = wrap76(Buffer.from(input.text, "utf8").toString("base64"));
  } else if (attachments.length === 0 && htmlPart) {
    const alt = boundary(seed);
    bodyHeaders = `Content-Type: multipart/alternative; boundary="${alt}"`;
    body = [
      `--${alt}`, textPart,
      `--${alt}`, htmlPart,
      `--${alt}--`, "",
    ].join(CRLF);
  } else {
    const mixed = boundary(seed);
    const alt = boundary(seed + 1);

    const inner = htmlPart
      ? [
          `Content-Type: multipart/alternative; boundary="${alt}"`, "",
          `--${alt}`, textPart,
          `--${alt}`, htmlPart,
          `--${alt}--`, "",
        ].join(CRLF)
      : textPart;

    const parts: string[] = [`--${mixed}`, inner];

    for (const a of attachments) {
      const buf = typeof a.content === "string"
        ? Buffer.from(a.content, "base64")
        : Buffer.from(a.content);
      // The filename is a header value too, and a PDF named from a customer's
      // company name reaches it.
      const name = sanitiseHeaderValue(a.filename).replace(/"/g, "'");
      parts.push(
        `--${mixed}`,
        `Content-Type: ${sanitiseHeaderValue(a.contentType ?? "application/pdf")}; name="${name}"${CRLF}` +
        `Content-Transfer-Encoding: base64${CRLF}` +
        `Content-Disposition: attachment; filename="${name}"${CRLF}${CRLF}` +
        wrap76(buf.toString("base64")),
      );
    }
    parts.push(`--${mixed}--`, "");

    bodyHeaders = `Content-Type: multipart/mixed; boundary="${mixed}"`;
    body = parts.join(CRLF);
  }

  return [...headers, bodyHeaders, "", body].join(CRLF);
}

/** The complete `raw` value for `users.messages.send`. */
export function buildGmailRaw(input: MimeInput): string {
  return toBase64Url(buildMimeMessage(input));
}
