/**
 * What a customer is told when their hosting is suspended.
 *
 * ─── THE DEAD END THIS CLOSES ───────────────────────────────────────────────
 * Found 11 Sep 2026 in the browser, on the new portal test fixture: a suspended
 * account rendered a red "Suspended" pill and nothing else. No reason, no date,
 * no next step, and — worst of it — nothing about whether the site and mailboxes
 * still exist. That is the §24 dead end in its purest form, on the one screen a
 * customer opens while panicking.
 *
 * The `failed` state on the same page already does this properly. This brings
 * `suspended` up to it.
 *
 * ─── THE RULE: NEVER INVENT THE REASON ──────────────────────────────────────
 * `hosting_accounts` has no `suspension_reason` column. There are only facts
 * that sometimes imply one:
 *
 *   is_trial + trial_ends_at in the past   → the trial ran out
 *   expires_at in the past                 → the paid period ran out
 *   neither                                → WE DO NOT KNOW
 *
 * The third case is real and common: a refund suspends an account mid-term
 * (`refund_payment`, migration 20260911130000), and so does an operator acting
 * by hand. Both leave a row whose dates look perfectly healthy.
 *
 * So the third case says a person paused it and to ask. It does NOT reach for
 * the likeliest-sounding cause. "Your payment failed" shown to somebody whose
 * payment did not fail sends them to their bank, and the true reason — a refund
 * they requested, or a deliberate hold — never gets mentioned.
 *
 * ─── WHAT EVERY VERSION MUST SAY ────────────────────────────────────────────
 * That nothing has been deleted. It is the first thing a customer needs and the
 * one thing the old card never mentioned. It is also true by construction:
 * `refund_payment` suspends and is forbidden from terminating (Pardeep, 11 Sep:
 * "Suspend the hosting but don't delete it. Admin will decide to delete it"),
 * and a deleted account would carry status `terminated`, not `suspended`.
 *
 * But it is phrased as "nothing has been deleted", never "it will not be" —
 * deletion IS the admin's decision, so a promise of permanence would be a lie
 * this module has no standing to make.
 */

import { formatDate } from "@/lib/utils";

export interface SuspensionFacts {
  /** `hosting_accounts.is_trial`. */
  isTrial: boolean | null | undefined;
  /** `hosting_accounts.trial_ends_at`. */
  trialEndsAt: string | null | undefined;
  /** `hosting_accounts.expires_at`. */
  expiresAt: string | null | undefined;
  /** `hosting_accounts.suspended_at`. */
  suspendedAt: string | null | undefined;
  /** Now, injectable so the tests are not time-dependent. */
  now?: Date;
}

export type SuspensionCause = "trial_ended" | "term_ended" | "unknown";

export interface SuspensionNotice {
  cause: SuspensionCause;
  /** One sentence: what happened. Never a guess. */
  headline: string;
  /** What is true of their site and data right now. */
  reassurance: string;
  /** The single thing they can do, as words. The caller supplies the link. */
  action: string;
  /**
   * Which portal route the action points at. `shop` when buying is the actual
   * remedy, `support` when a person has to be asked — including every case
   * where the reason is unknown, because a shop link there would be answering
   * a question the customer has not been told the answer to.
   */
  actionRoute: "shop" | "support";
}

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * `4 Sept 2026`, or null when there is no usable date.
 *
 * ─── WHY THE SHARED FORMATTER AND NOT A LOCAL ONE ───────────────────────────
 * The first version of this called `toLocaleDateString` here, which formats in
 * the RUNNING PROCESS's timezone. On Cloud Run that is UTC, so a timestamp of
 * `2026-09-04T19:00:00Z` would have told a customer in India that their trial
 * ended on the 4th when for them it ended on the 5th. `formatDate` pins
 * Asia/Kolkata, which is the whole reason it exists.
 *
 * It also keeps these dates identical to every other date in the app, and it
 * returns `"—"` rather than null for nothing — which reads fine in a table cell
 * and badly mid-sentence ("paused on —"), so that case is mapped back to null
 * and the clause is dropped instead.
 */
function niceDate(value: string | null | undefined): string | null {
  if (!parse(value)) return null;
  const formatted = formatDate(value, "short");
  return formatted === "—" ? null : formatted;
}

export function describeSuspension(facts: SuspensionFacts): SuspensionNotice {
  const now = facts.now ?? new Date();
  const trialEnd = parse(facts.trialEndsAt);
  const termEnd = parse(facts.expiresAt);

  /* Nothing is deleted, and the account can be switched back on. Shared,
     because it is true in every case and it is the sentence the customer most
     needs — see the header on why it is not phrased as a promise. */
  const reassurance =
    "Your files, databases and email are still here — nothing has been deleted, and the account can be switched back on.";

  /* ─── TRIAL FIRST ─────────────────────────────────────────────────────────
     Checked before the paid term because a trial row often carries BOTH dates,
     and a trial that ran out is a different conversation from a bill: there is
     nothing to renew, only something to buy. Getting this order wrong tells a
     trial user their "paid period" ended, which they will read as a charge they
     do not recognise. */
  if (facts.isTrial && trialEnd && trialEnd <= now) {
    const on = niceDate(facts.trialEndsAt);
    return {
      cause: "trial_ended",
      headline: `Your free trial ended${on ? ` on ${on}` : ""}, so the site is offline.`,
      reassurance,
      action: "Pick a plan to bring it back online",
      actionRoute: "shop",
    };
  }

  if (termEnd && termEnd <= now) {
    const on = niceDate(facts.expiresAt);
    return {
      cause: "term_ended",
      headline: `The period you paid for ended${on ? ` on ${on}` : ""}, so the site is offline.`,
      reassurance,
      /* Support, not shop. Renewing an existing account is not the same
         purchase as buying a new one, and the reseller may already have raised
         an invoice for it — sending the customer to the shop risks a second
         account for a domain they already host. */
      action: "Ask to renew it",
      actionRoute: "support",
    };
  }

  /* ─── WE DO NOT KNOW, AND WE SAY SO ───────────────────────────────────────
     Reached by a refund mid-term and by a manual hold. Naming who to ask is the
     whole value: it is a short conversation for them and an unanswerable
     mystery for us. */
  const on = niceDate(facts.suspendedAt);
  return {
    cause: "unknown",
    headline: `This account was paused${on ? ` on ${on}` : ""}, so the site is offline.`,
    reassurance,
    action: "Ask why it was paused and to switch it back on",
    actionRoute: "support",
  };
}
