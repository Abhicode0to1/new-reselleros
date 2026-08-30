/**
 * A customer message the agent could not answer, and whether to try again.
 *
 * ─── THE SILENCE THIS ENDS ──────────────────────────────────────────────────
 * 30 Aug 2026, 19:47. Pardeep had asked for a 30-seat quote; the app drafted
 * Q-ADPL-2026-27-0044 and held it, correctly, because the mail had not said monthly or
 * annual and the price would have been an assumption. It replied asking which. He answered
 * "monthly" — the exact word the whole flow was waiting for — and:
 *
 *   reply.send / failed — "Gemini ne 15 second me jawab nahi diya, dobara koshish ke baad bhi"
 *
 * Gemini timed out. The webhook had already returned. Nothing else looked at that lead
 * again. A customer who did what he was asked got silence, and a finished quote sat unsent.
 *
 * The failure was transient — the next call minutes later worked. What was missing was
 * anyone to make it.
 *
 * ─── WHY NOT `ai_sales_loops` ───────────────────────────────────────────────
 * That queue exists and would have been the obvious home. Its own rule forbids it:
 *
 *   "the customer has written since this was scheduled, so there is nothing to chase"
 *
 * A nudge is cancelled by a customer message. A retry is CAUSED by one. Same table,
 * opposite meaning — reusing it would have looked right and quietly dropped every retry.
 *
 * ─── AND NO NEW TABLE EITHER ────────────────────────────────────────────────
 * The queue is derived, not stored: `ai_action_log` already records every failed
 * `reply.send`, and `inbound_emails` already holds the message. A lead needing a retry is
 * one with a recent failure and no success after it. That makes the queue self-clearing —
 * once a reply lands, the lead stops matching — with nothing to migrate and no second
 * record of the truth to drift.
 */

/** Everything the decision needs about one lead's recent history. */
export interface RetryCandidate {
  leadId: string;
  /** When the agent last failed on this lead. */
  failedAt: string;
  /** How many times it has failed since the last success. */
  failures: number;
  /** Last successful reply, or null. Compared against `failedAt`. */
  lastSuccessAt: string | null;
  /** The newest customer message on this lead, or null when there is none to answer. */
  lastCustomerMessageAt: string | null;
  /** A person is on it — stage moved to something a human drives, or lead is junk. */
  humanTookOver: boolean;
  isJunk: boolean;
}

export interface RetryVerdict {
  retry: boolean;
  /** Short machine reason, for counting in the cron's report. */
  reason: string;
  /** One sentence for the operator and the log. */
  detail: string;
}

/**
 * Wait this long before the first retry.
 *
 * Not immediate: the failures worth retrying are timeouts and rate limits, and both mean
 * the far side is busy right now. Retrying inside a minute mostly buys a second failure.
 * Five minutes is also under the time a customer starts wondering.
 */
export const RETRY_AFTER_MINUTES = 5;

/**
 * Stop after this many failures on one lead.
 *
 * Three is the point where "transient" stops being the likely explanation. Past it the
 * message probably breaks something specific, and repeating it forever spends the tenant's
 * Gemini quota — the same quota the live path needs — on a call that will fail again.
 */
export const MAX_RETRIES = 3;

/**
 * Give up on anything older than this.
 *
 * A day-old answer to "monthly?" is worse than none: the customer has moved on, and a reply
 * arriving out of nowhere reads as a system that has just woken up. Two hours keeps it
 * inside the same conversation.
 */
export const GIVE_UP_AFTER_HOURS = 2;

export function shouldRetryReply(c: RetryCandidate, nowISO: string): RetryVerdict {
  if (c.isJunk) {
    return { retry: false, reason: "lead_is_junk", detail: "the lead was marked junk after the reply failed" };
  }

  if (c.humanTookOver) {
    /* Same reasoning `shouldNudge` gives for its own version: an automated message talking
       over a person who has picked the lead up is worse than the silence it is fixing. */
    return { retry: false, reason: "human_took_over", detail: "a person is handling this lead now" };
  }

  if (!c.lastCustomerMessageAt) {
    return { retry: false, reason: "nothing_to_answer", detail: "no customer message on this lead to answer" };
  }

  if (c.lastSuccessAt && c.lastSuccessAt > c.failedAt) {
    /* The commonest exit, and the one that makes this queue self-clearing: something
       already answered — a later inbound message, or a person. */
    return { retry: false, reason: "already_answered", detail: "a reply went out after the failure" };
  }

  if (c.failures >= MAX_RETRIES) {
    return {
      retry: false,
      reason: "gave_up",
      detail: `failed ${c.failures} times — not transient, and a person should look at this lead`,
    };
  }

  const ageMin = (Date.parse(nowISO) - Date.parse(c.failedAt)) / 60_000;
  if (Number.isNaN(ageMin)) {
    return { retry: false, reason: "bad_timestamp", detail: "the failure has no readable timestamp" };
  }

  if (ageMin < RETRY_AFTER_MINUTES) {
    return {
      retry: false,
      reason: "too_soon",
      detail: `failed ${Math.round(ageMin)} min ago — waiting ${RETRY_AFTER_MINUTES} min before trying again`,
    };
  }

  if (ageMin > GIVE_UP_AFTER_HOURS * 60) {
    return {
      retry: false,
      reason: "too_old",
      detail: `failed ${Math.round(ageMin / 60)} hours ago — too late to answer as part of that conversation`,
    };
  }

  return {
    retry: true,
    reason: "retry",
    detail: `the agent failed ${Math.round(ageMin)} min ago and nothing has answered since`,
  };
}
