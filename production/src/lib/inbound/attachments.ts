/**
 * Pulling attachments out of an inbound-email webhook payload.
 *
 * ─── WHY THIS IS ITS OWN PURE MODULE ────────────────────────────────────────
 * Every inbound-parse provider ships attachments in a different shape, and the
 * webhook had none of them wired — which is why `billing@` could be routed but
 * not read. Normalising here, with tests, means the shapes can be extended
 * without touching the route, and a provider swap is a data change rather than a
 * debugging session inside a handler that also talks to Gemini and Postgres.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
 * It does not fetch anything. Mailgun sends attachment URLs rather than bytes,
 * and a pure function that quietly made an HTTP call would be untestable and
 * would let a webhook payload aim a request wherever it liked. URL-style
 * attachments are returned with `url` set and `base64` null, and the caller
 * decides — deliberately, with the fetch in one visible place.
 */

/** A readable attachment, normalised. Exactly one of base64/url is set. */
export interface InboundAttachment {
  filename: string;
  mimeType: string;
  /** Raw base64, no `data:` prefix. Null when the provider sent a URL instead. */
  base64:   string | null;
  /** Provider-hosted location. Null when the bytes came inline. */
  url:      string | null;
  /** Bytes, when the provider reported it. Used to refuse oversized files. */
  size:     number | null;
}

/** What Gemini can actually read. Anything else is not worth uploading. */
const READABLE = /^(image\/(png|jpe?g|webp|heic|heif)|application\/pdf)$/i;

/** 20 MB. Above this a bill is not a bill, and Gemini would reject it anyway. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function isReadableAttachment(mimeType: string | null | undefined): boolean {
  return READABLE.test((mimeType ?? "").trim());
}

/** Guess a mime type from the filename when the provider omitted one. */
export function mimeFromFilename(filename: string | null | undefined): string {
  const ext = (filename ?? "").trim().toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "pdf":  return "application/pdf";
    case "png":  return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "heic": return "image/heic";
    case "heif": return "image/heif";
    default:     return "";
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v
  : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v)
  : null;

/**
 * Normalise the attachment array across providers.
 *
 *   Postmark  `Attachments`  [{ Name, Content(base64), ContentType, ContentLength }]
 *   Mailgun   `attachments`  [{ url, name, "content-type", size }]   ← URL, not bytes
 *   Generic   `attachments`  [{ filename, content(base64), contentType }]
 *
 * A `data:` prefix is stripped: some providers send a full data URI and passing
 * that to Gemini as raw base64 fails with an unhelpful error.
 */
export function extractAttachments(body: Record<string, unknown>): InboundAttachment[] {
  const raw =
    (Array.isArray(body["Attachments"]) ? body["Attachments"] : null) ??
    (Array.isArray(body["attachments"]) ? body["attachments"] : null) ??
    [];

  const out: InboundAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;

    const filename = str(o.Name) || str(o.filename) || str(o.name) || str(o.file_name) || "attachment";
    let mimeType   = str(o.ContentType) || str(o.contentType) || str(o["content-type"]) || str(o.mime_type);
    if (!mimeType) mimeType = mimeFromFilename(filename);

    const url = str(o.url) || str(o.Url) || null;

    let base64: string | null = str(o.Content) || str(o.content) || str(o.data) || null;
    // `data:application/pdf;base64,JVBER...` → `JVBER...`
    if (base64 && base64.startsWith("data:")) {
      const comma = base64.indexOf(",");
      base64 = comma > -1 ? base64.slice(comma + 1) : null;
    }
    if (base64 === "") base64 = null;

    if (!base64 && !url) continue;   // nothing usable

    out.push({
      filename,
      mimeType,
      base64,
      url,
      size: num(o.ContentLength) ?? num(o.size) ?? num(o.Length) ?? null,
    });
  }
  return out;
}

/**
 * The one attachment worth reading as a bill.
 *
 * PDF wins over an image when both are present: a vendor emailing an invoice
 * sends the PDF and often a logo or signature image alongside it, and picking
 * "the first attachment" would read the logo. Unreadable types and anything over
 * the size cap are dropped rather than uploaded and then rejected downstream.
 */
export function pickBillAttachment(attachments: InboundAttachment[]): InboundAttachment | null {
  const usable = attachments.filter(
    (a) => isReadableAttachment(a.mimeType) && (a.size === null || a.size <= MAX_ATTACHMENT_BYTES),
  );
  if (usable.length === 0) return null;
  return usable.find((a) => /^application\/pdf$/i.test(a.mimeType)) ?? usable[0];
}
