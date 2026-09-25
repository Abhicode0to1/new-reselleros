/**
 * Hosting renewals, from the paid renewal to DMS extending the account
 * (owner, 25 Sep 2026: "Fix those too").
 *
 * Billing and renewals are ResellerOS's, but DMS enforces a hosting account's expiry
 * itself: its expiry worker suspends an account whose expiryDate has passed. Before this
 * a paid hosting renewal was re-queued as a NEW account (the webhook read every paid
 * quote as a sale), DMS's expiry never moved, and the customer who had paid would be
 * suspended anyway. Now:
 *   1. the payment webhook recognises the renewal of a vendor-`hosting` subscription and
 *      queues a RENEWAL row (`plan = HOSTING_RENEWAL_PLAN`), which the provision-hosting
 *      worker never picks up;
 *   2. /api/cron/renew-hosting sends the DMS engine's `hosting.renew` with the expiry DMS
 *      holds as `expiryBefore`, so a second send extends nothing twice.
 */

/** The provisioning_requests `plan` that marks a hosting row as a RENEWAL. */
export const HOSTING_RENEWAL_PLAN = "hosting-renewal";

/** The paying side's own switch. Only the exact string "1" opens it (AGENTS.md L41). */
export function hostingRenewalEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.HOSTING_RENEWAL_LIVE === "1";
}

/** One engine command id per row per IST day, so a re-run the same day replays. */
export function hostingRenewalCommandId(requestId: string, now: Date = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000); // AGENTS.md §6 — IST, not UTC
  return `rsos-hostrenew-${requestId}-${ist.toISOString().slice(0, 10)}`;
}

/**
 * How many months a paid renewal buys, read from the renewal quote's line `commitment`
 * (which the renewal helper sets from the subscription's own term) — NOT the quote's
 * `extension_months`, which that helper writes as 12 even for a monthly subscription
 * (reported to the owner 25 Sep 2026; it is in a blocked folder). Null when the quote
 * does not say, so the caller holds rather than guesses.
 */
export function monthsFromRenewalLines(lineItems: unknown): 1 | 12 | null {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return null;
  const commitments = new Set(
    lineItems
      .map((l) => (l && typeof l === "object" ? (l as { commitment?: unknown }).commitment : undefined))
      .filter((c): c is string => typeof c === "string"),
  );
  if (commitments.size !== 1) return null; // none stated, or mixed terms: not one answer
  const [c] = [...commitments];
  if (c === "monthly") return 1;
  if (c === "annual_yearly") return 12;
  return null; // annual_monthly / annual_quarterly: a year billed in parts — not guessed here
}
