/**
 * Normalising what an inbound-parse provider POSTs, for the support ingest routes.
 *
 * Pure and dependency-free, so every field mapping below is testable without a webhook — the
 * same reason `routing.ts` and `disposition.ts` are split out.
 *
 * ─── WHY THIS IS NOT SHARED WITH api/webhooks/inbound-email ─────────────────
 * That route's normaliser also reconstructs RFC 5322 headers across three provider shapes (for
 * the bulk-mail suppression in follow-up.ts) and pulls attachments apart (for the billing
 * branch). The support ingest needs neither, and moving that function would have meant editing
 * a 954-line live route that a source-shape test pins, to serve a caller that uses a third of
 * it. So this is the small overlapping half, extracted and named, rather than a refactor of a
 * working path — AGENTS.md §10's "do not clobber" applied to one's own earlier work.
 *
 * The KEY LISTS ARE THE SAME, deliberately. A provider that names the recipient
 * `OriginalRecipient` does so on both endpoints, and two divergent lists would mean support
 * mail silently losing a field that sales mail reads fine.
 */

/** Everything the support routes need from a provider payload. */
export interface SupportEmailPayload {
  /** Lower-cased bare address. "" when unparseable — the caller must refuse those. */
  fromEmail: string;
  /** Display name, or "" when the provider sent none. */
  fromName: string;
  /** The address the mail was sent TO, raw. "" when the provider sent none. */
  toAddress: string;
  subject: string;
  /** Plain-text body. May be "" — a customer who sends only an attachment has said nothing. */
  text: string;
  /** Provider message id, or a synthesised one. Never "". */
  messageId: string;
}

/** Parse `Display Name <a@b.com>` → { name, email }. Falls back gracefully. */
export function parseFromAddress(raw: string): { name: string; email: string } {
  const s = (raw ?? "").trim();
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  const email = /@/.test(s) ? s.toLowerCase() : "";
  return { name: "", email };
}

/**
 * Pull the fields out of whatever shape the provider used.
 *
 * ─── THE SYNTHESISED MESSAGE ID IS LOAD-BEARING ─────────────────────────────
 * `messageId` is the idempotency key: the caller claims it in `inbound_emails`, whose UNIQUE
 * constraint is the only thing stopping a provider retry from answering the same customer
 * twice. A provider that omits it would otherwise leave the key empty, every retry would look
 * new, and the agent would reply to one message repeatedly.
 *
 * So an absent id becomes one derived from the sender, the subject and the body — the same
 * shape the sales webhook uses, with the body added. Without the body, two genuinely different
 * messages sent from one address under one subject ("Re: mail issue") would collide and the
 * SECOND one would be silently dropped as a duplicate, which is worse than a double reply:
 * nobody finds out.
 */
export function normaliseSupportEmail(body: Record<string, unknown>): SupportEmailPayload {
  const str = (...keys: string[]): string => {
    for (const k of keys) {
      const v = body[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };

  const rawFrom = str("from", "sender", "From", "from_email");
  const { name: parsedName, email: fromEmail } = parseFromAddress(rawFrom);

  const subject = str("subject", "Subject");
  const text = str("text", "body-plain", "plain", "TextBody", "stripped-text", "body");

  const provided = str("messageId", "message_id", "Message-Id", "MessageID", "Message-ID");

  return {
    fromEmail,
    fromName: str("fromName", "from_name", "sender_name") || parsedName,
    toAddress: str("to", "To", "recipient", "recipients", "envelope_to", "OriginalRecipient"),
    subject,
    text,
    messageId:
      provided ||
      `noid-${fromEmail}-${subject}-${text.slice(0, 120)}`.replace(/\s+/g, " ").slice(0, 200),
  };
}
