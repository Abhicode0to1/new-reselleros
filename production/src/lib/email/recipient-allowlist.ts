/**
 * Who a dev machine may email — EMAIL_RECIPIENT_ALLOWLIST (29 Sep 2026).
 *
 * The local database holds real customers (12 of 20 local customers have real-looking
 * addresses). With a real SMTP login in `.env.local`, any local job — dunning, renewal
 * reminders, an auto-quote — would reach them. When the variable is set, mail goes ONLY
 * to what it lists:
 *
 *   EMAIL_RECIPIENT_ALLOWLIST="@anutech.in, tester@gmail.com"
 *
 * "@domain" allows that exact domain (not a lookalike, not a subdomain); anything else is
 * one exact address; case does not matter. UNSET means no filter, which is what
 * production needs — the variable only ever exists on a dev machine, and a production
 * deploy that filtered by default would silently stop every customer email.
 *
 * Same rule as DMS's lib/email/recipient-allowlist.ts, so one setting reads the same in
 * both apps.
 */
export interface AllowlistDecision {
  allowed: boolean;
  /** Why not, for email_log and the console. Null when allowed. */
  reason: string | null;
}

export function parseAllowlist(raw: string | undefined): string[] | null {
  if (raw === undefined || !raw.trim()) return null;
  return raw
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function recipientAllowed(to: string, raw: string | undefined): AllowlistDecision {
  const list = parseAllowlist(raw);
  if (list === null) return { allowed: true, reason: null };

  const addr = to.trim().toLowerCase();
  const domain = addr.includes("@") ? addr.slice(addr.lastIndexOf("@")) : null;
  const ok = list.some((e) => (e.startsWith("@") ? e === domain : e === addr));
  return ok
    ? { allowed: true, reason: null }
    : { allowed: false, reason: `not sent — ${to} is not on EMAIL_RECIPIENT_ALLOWLIST (this machine's recipient filter)` };
}
