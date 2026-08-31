/**
 * Where a customer's reply must LAND — which is not the same question as "who owns this".
 *
 * ─── THE REPLY THAT VANISHED ────────────────────────────────────────────────
 * 31 Aug 2026, 14:32. Pardeep answered a quote email — "mujhe 66 email id ka quote chahiye" —
 * and the app never saw it. `inbound_emails` had nothing for that half-hour. Not held, not
 * skipped, not spam: it never arrived.
 *
 *   the quote email set  replyTo: tenants.email  ->  pardeep@anutech.in
 *   the Gmail connector reads                        sales@anutech.in
 *
 * So the reply went to a mailbox the app does not read, and nothing anywhere said so. Gmail
 * even showed it plainly — "to pardeep" — under a message that came from Sales Anutech.
 *
 * The old comment was not careless, it was OUT OF DATE: "replies go to the tenant, not to the
 * envelope sender — a customer answering this must reach a person." That was right while mail
 * left through Resend as `onboarding@resend.dev`, an address nobody can answer. It became
 * wrong the day the app started sending from — and reading — the tenant's own Gmail: the
 * mailbox that ingests IS a person's mailbox, and pointing replies elsewhere took the
 * conversation out of the pipeline.
 *
 * ─── THE RULE ───────────────────────────────────────────────────────────────
 * Reply-To must be an address the app INGESTS. Anything else is a conversation the app cannot
 * continue, and the failure is silent — which is the worst property a mail bug can have.
 *
 * `tenants.email` stays as the last fallback, because a tenant with no connected mailbox is
 * better served by a reply reaching a human than by no Reply-To at all. It just stops being
 * the FIRST answer.
 */

/** The connected Google account for a tenant, as stored on `user_google_tokens`. */
export interface IngestMailbox {
  google_email: string | null;
}

/**
 * The address to put in Reply-To.
 *
 * @param ingest  connected Google accounts for this tenant — the mailboxes the app reads
 * @param tenantEmail `tenants.email`, the owner's address; the fallback, not the default
 */
export function replyToAddress(
  ingest: readonly IngestMailbox[] | null | undefined,
  tenantEmail: string | null | undefined,
): string | undefined {
  const readable = (ingest ?? [])
    .map((a) => a.google_email?.trim())
    .find((e): e is string => Boolean(e));

  /* The mailbox the app reads wins, always. It is also a real person's inbox — the tenant's
     own Workspace account — so nothing is lost by preferring it. */
  if (readable) return readable;

  const owner = tenantEmail?.trim();
  return owner || undefined;
}
