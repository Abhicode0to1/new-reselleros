/**
 * Whether a scheduled follow-up should still go out when its time arrives.
 *
 * ─── WHY THIS IS A DECISION AND NOT JUST A `WHERE scheduled_at <= now()` ────
 * The cron's query can only ask "is it due". Everything that makes an automated nudge
 * embarrassing happened AFTER the row was written:
 *
 *   - the customer replied, so "just following up!" arrives on top of their own answer
 *   - somebody won or lost the deal, and the pipeline moved on
 *   - a person took the lead over (requires_human_attention), and the machine talking over
 *     them is worse than the machine saying nothing
 *   - the lead was marked junk
 *
 * Every one of those is a reason the row is stale rather than due, and none of them is
 * visible to a timestamp comparison. A nudge sent into any of them does not read as a bug —
 * it reads as nobody being home, which is the exact impression this feature exists to avoid.
 *
 * Pure, so all four can be tested without a database or a clock.
 */

export type LoopSkipReason =
  | "customer_replied"
  | "deal_closed"
  | "human_took_over"
  | "lead_is_junk";

export interface LoopCandidate {
  /** Lead stage at the moment the cron looked. */
  stage: string;
  isJunk: boolean;
  requiresHumanAttention: boolean;
  /** When the loop row was written. */
  scheduledFrom: Date;
  /**
   * Newest customer message on this lead, or null if they have never written since. Compared
   * against `scheduledFrom` rather than against "now" — a reply that arrived BEFORE the loop
   * was scheduled is what the agent was already answering, not a reason to cancel.
   */
  lastCustomerMessageAt: Date | null;
}

export type LoopVerdict =
  | { nudge: true }
  | { nudge: false; reason: LoopSkipReason; detail: string };

/** Stages where the deal is over and a nudge is noise. */
const CLOSED_STAGES = new Set(["won", "lost"]);

export function shouldNudge(c: LoopCandidate): LoopVerdict {
  if (c.isJunk) {
    return { nudge: false, reason: "lead_is_junk", detail: "the lead was marked junk after this follow-up was scheduled" };
  }

  if (c.requiresHumanAttention) {
    return {
      nudge: false,
      reason: "human_took_over",
      detail: "a person is handling this lead — an automated nudge would talk over them",
    };
  }

  if (CLOSED_STAGES.has(c.stage)) {
    return { nudge: false, reason: "deal_closed", detail: `the deal is already ${c.stage}` };
  }

  if (c.lastCustomerMessageAt !== null && c.lastCustomerMessageAt > c.scheduledFrom) {
    return {
      nudge: false,
      reason: "customer_replied",
      detail: "the customer has written since this was scheduled, so there is nothing to chase",
    };
  }

  return { nudge: true };
}

/**
 * When a follow-up scheduled now should fire.
 *
 * `inHours` is already bounded 1..720 by SALES_AGENT_SCHEMA, so this does no clamping of its
 * own — two places clamping the same value is how they end up disagreeing. It takes `now`
 * rather than reading the clock so the result is testable.
 */
export function loopDueAt(now: Date, inHours: number): Date {
  return new Date(now.getTime() + inHours * 60 * 60 * 1000);
}
