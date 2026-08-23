/**
 * Public quote-link helpers (SEC-1) — PURE string builders, safe to import from
 * client components (no node built-ins). Token VERIFICATION lives server-only in
 * `accept-token.ts` (it uses `crypto`), so keep these two apart.
 *
 * Customer-facing quote links carry an unguessable per-quote token
 * (`quotes.public_token`, migration 0115) instead of relying on the sequential
 * quote id as a secret.
 */

/** Path + token query for a quote's public accept page. */
export function quoteAcceptPath(id: string, token: string): string {
  return `/quote/${encodeURIComponent(id)}/accept?t=${encodeURIComponent(token)}`;
}

/**
 * Absolute customer-facing accept URL (what we email / WhatsApp / copy).
 *
 * ─── RETURNS null RATHER THAN A RELATIVE PATH ───────────────────────────────
 * Found on 23 Aug 2026: `NEXT_PUBLIC_APP_URL` was not set on Cloud Run, and the renewals
 * cron called this as `quoteAcceptUrl(process.env.NEXT_PUBLIC_APP_URL ?? "", …)`. With an
 * empty base this happily returned `/quote/Q-…/accept?t=…` — a relative path, which in an
 * EMAIL is not a degraded link, it is a dead one: no mail client can resolve it.
 *
 * So renewal reminders went to customers carrying an accept link that could not be clicked.
 * The renewal is the money; the link is how it converts. Nothing errored, nothing logged,
 * and the cron reported success.
 *
 * A missing host is now `null`, so a caller must decide what to do about it — send the mail
 * without a link and say why, or skip the send. What it can no longer do is quietly mail a
 * URL with no host in it. The `?? ""` at a call site was the whole bug, and a function that
 * accepts "" and returns something plausible is what let it through.
 */
export function quoteAcceptUrl(appUrl: string | null | undefined, id: string, token: string): string | null {
  const base = (appUrl ?? "").trim().replace(/\/+$/, "");
  /* Must be absolute. A bare host with no scheme is equally unclickable in mail, and
     "looks like a URL" is not the test — "a mail client can resolve it" is. */
  if (!/^https?:\/\/[^\s/]+/i.test(base)) return null;
  return `${base}${quoteAcceptPath(id, token)}`;
}
