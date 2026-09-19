/**
 * When to warn somebody that a domain is about to lapse — and which warning.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Measured 11 Sep 2026: `asset-sweep` keeps `domains.expires_at` accurate and
 * then tells nobody. There is no email, no alert, no notification anywhere in the
 * codebase for an expiring domain. In this database that meant
 * `acme-legacy.net` had lapsed nine days earlier and sat in `grace` with nobody
 * informed, and `acmecorp.com` had eleven days left with nobody informed.
 *
 * A domain lapsing quietly is the worst outcome a domain business has: the site
 * and the email stop, the customer finds out from their own customers, and
 * getting the name back after it drops is somebody else's auction.
 *
 * ─── DOMAINS ARE NOT SUBSCRIPTIONS HERE (Pardeep, 11 Sep 2026) ──────────────
 * Asked whether a domain should become a subscription row so the existing
 * renewal cron, cadence emails and quote machinery would handle it for free.
 * Answer: its own renewal path. The reason is that a ₹900/year domain becoming
 * ₹75/month of recurring revenue would change MRR and the subscriptions list —
 * figures already being quoted — so this is deliberately a parallel path and not
 * a reuse of `lib/renewals/`.
 *
 * ─── ONE NOTICE PER STEP, AND NEVER A CATCH-UP BURST ────────────────────────
 * The steps are 30 / 14 / 7 / 1 days out, plus one after it lapses. The rule that
 * matters is the SECOND one: a domain first seen five days before expiry must get
 * the 7-day notice ONCE, not the 30, the 14 and the 7 in the same minute. A
 * customer whose inbox gets three warnings about one domain learns to ignore all
 * of them, which is worse than the silence this replaces.
 *
 * So `noticeDueFor` returns at most ONE step — the nearest one that applies and
 * has not been sent — and the caller records it.
 *
 * ─── THE SENT-LIST IS KEYED ON THE TERM, NOT THE DOMAIN ─────────────────────
 * `alreadySent` is the steps sent for THIS expiry date. When a domain renews, its
 * `expires_at` moves and the whole cadence becomes available again with no rows
 * to delete — which is why the caller's unique index carries the expiry. Keying
 * on the domain alone would warn a customer once in the domain's life and then
 * stay silent through every later renewal.
 */

import { daysBetween } from "@/lib/utils";

/** Which warning. `lapsed` is after the expiry date has passed. */
export type RenewalNoticeStep = "d30" | "d14" | "d7" | "d1" | "lapsed";

/**
 * Days-before-expiry for each step, nearest first.
 *
 * Ordered nearest-first because `noticeDueFor` walks it and takes the first
 * match, which is what makes a late-discovered domain get one notice instead of
 * the whole ladder.
 */
export const NOTICE_STEPS: ReadonlyArray<{ step: RenewalNoticeStep; daysBefore: number }> = [
  { step: "d1", daysBefore: 1 },
  { step: "d7", daysBefore: 7 },
  { step: "d14", daysBefore: 14 },
  { step: "d30", daysBefore: 30 },
];

/** Statuses of the domain row itself. */
export type DomainNoticeStatus =
  | "pending"
  | "active"
  | "grace"
  | "expired"
  | "transferred_out"
  | "failed";

export interface NoticeDecision {
  step: RenewalNoticeStep;
  /** Days until expiry. Negative once it has passed. */
  daysLeft: number;
  /** True for the `lapsed` step — the copy and the urgency differ. */
  alreadyLapsed: boolean;
}

/**
 * The one notice due for this domain today, or null.
 *
 * `today` and `expiresAt` are ISO dates. Both are compared as CALENDAR dates via
 * `daysBetween`, never as elapsed hours — a domain bought at 11pm must not be a
 * day out from one bought at 1am, which is the bug `daysBetween` exists for and
 * which bit `expiryPhrase` on 10 Sep.
 */
export function noticeDueFor(args: {
  expiresAt: string | null;
  status: DomainNoticeStatus;
  today: string;
  /** Steps already sent for THIS expiry date. */
  alreadySent: readonly RenewalNoticeStep[];
}): NoticeDecision | null {
  /* No expiry, nothing to warn about. A `pending` domain has not been registered
     yet, so its absent date is not a problem to report — the
     paid-but-undelivered screens own that row. */
  if (!args.expiresAt) return null;

  /* Nothing to warn about once it is gone or was never ours. `expired` is
     included deliberately: the `lapsed` notice belongs to `grace`, the window
     where the name can still be recovered. Warning about a domain that has
     already dropped invites a customer to pay for something we cannot get back. */
  if (args.status === "transferred_out" || args.status === "failed" || args.status === "pending") {
    return null;
  }

  const sent = new Set(args.alreadySent);
  const daysLeft = daysBetween(args.today, args.expiresAt);

  if (daysLeft < 0) {
    /* One notice after it lapses, not one a day. The operator's own alert is
       what escalates from here; pestering the customer daily about a name they
       may have chosen to drop is not a renewal strategy. */
    if (args.status === "expired") return null;
    return sent.has("lapsed") ? null : { step: "lapsed", daysLeft, alreadyLapsed: true };
  }

  /* ─── ONE applicable step, chosen by the DATE alone ───────────────────────
     The nearest window that still contains today. Then, separately, send it only
     if it has not gone out.

     Those two decisions must not be fused into one loop, and the first version
     of this fused them — it walked the ladder looking for the first step that
     both matched AND was unsent, so at 11 days out with `d14` already sent it
     fell through and sent `d30`. A "your domain expires in 30 days" email to
     somebody with 11 days left, right after the 14-day one. The catch-up burst
     this file exists to prevent, running backwards. Caught by its own test. */
  const applicable = NOTICE_STEPS.find(({ daysBefore }) => daysLeft <= daysBefore);
  if (!applicable) return null;

  return sent.has(applicable.step)
    ? null
    : { step: applicable.step, daysLeft, alreadyLapsed: false };
}

/**
 * How the warning reads. Plain, and it never invents a price.
 *
 * The amount is deliberately absent: a renewal is priced from the rate card at
 * the moment a quote is raised, and a figure in a warning email would be a
 * number the quote then contradicts — the same mistake `seat-request.ts`
 * documents and that the hosting upgrade avoids.
 */
export function noticeSubject(domain: string, d: NoticeDecision): string {
  if (d.alreadyLapsed) return `${domain} has expired — it can still be renewed`;
  if (d.daysLeft <= 1) return `${domain} expires tomorrow`;
  return `${domain} expires in ${d.daysLeft} days`;
}
