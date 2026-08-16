/**
 * Net Revenue Retention — how last period's customers behaved this period.
 *
 * ─── NEW CUSTOMERS ARE EXCLUDED, AND THAT IS THE WHOLE MEASURE ──────────────
 * NRR asks one question: of the revenue you already had, how much do you still have?
 * Adding new customers to it is the classic mistake, and it is not a rounding error —
 * a reseller signing a big new logo would show 180% NRR while every existing customer
 * quietly shrank. The number would rise fastest exactly when retention was worst.
 *
 * So the cohort is fixed at the START of the period. New customers are counted and
 * reported (they are the other half of the story) but never enter NRR.
 *
 *   NRR = (start + expansion − contraction − churn) / start
 *   GRR = (start − contraction − churn) / start        — never above 100%
 *
 * ─── IT NEEDS TWO SNAPSHOTS, AND SAYS SO WHEN IT HAS ONE ────────────────────
 * Retention is a comparison. With one snapshot there is nothing to compare against,
 * and the honest output is "not enough history yet" — not 100%, which is what an
 * empty comparison arithmetically produces and which reads as perfect retention.
 *
 * ─── EVERY MOVEMENT IS ATTRIBUTED TO EXACTLY ONE BUCKET ─────────────────────
 * A customer who existed before and shrank is contraction, not churn. One who left
 * entirely is churn, not 100% contraction. One who left and came back is
 * reactivation, not new. Double-counting any of these is how NRR ends up over 200%
 * with no expansion anywhere.
 */

export interface MrrPoint {
  /** Stable identity across periods. Customer, not subscription — a customer who
   *  swaps plans has not churned. */
  customerId: string;
  /** ₹/month. Whole rupees. */
  mrr: number;
}

export interface RetentionResult {
  /** ₹ MRR at the start, from the fixed cohort. */
  startingMrr: number;
  /** ₹ MRR now, from that SAME cohort. Excludes new customers. */
  endingCohortMrr: number;
  expansion: number;
  contraction: number;
  churned: number;
  /** ₹ from customers who did not exist at the start. Reported, never in NRR. */
  newMrr: number;
  /** ₹ from customers who were gone at the start and are back. */
  reactivatedMrr: number;
  /** Basis points. 11050 = 110.50%. Null when there is no starting MRR to retain. */
  nrrBps: number | null;
  /** Basis points, capped at 10000 by construction. Null for the same reason. */
  grrBps: number | null;
  counts: {
    retained: number;
    expanded: number;
    contracted: number;
    churned: number;
    new: number;
    reactivated: number;
  };
}

/**
 * Compare two points in time.
 *
 * `start` and `end` are the full customer→MRR picture at each moment. A customer
 * absent from `start` is new; absent from `end` (or at zero) is churned.
 */
export function computeRetention(start: readonly MrrPoint[], end: readonly MrrPoint[]): RetentionResult {
  const startMap = new Map<string, number>();
  for (const p of start) {
    if (p.mrr > 0) startMap.set(p.customerId, (startMap.get(p.customerId) ?? 0) + p.mrr);
  }
  const endMap = new Map<string, number>();
  for (const p of end) {
    if (p.mrr > 0) endMap.set(p.customerId, (endMap.get(p.customerId) ?? 0) + p.mrr);
  }

  let startingMrr = 0, endingCohortMrr = 0;
  let expansion = 0, contraction = 0, churned = 0;
  let newMrr = 0;
  const counts = { retained: 0, expanded: 0, contracted: 0, churned: 0, new: 0, reactivated: 0 };

  /* The cohort: everyone who was paying at the start. Fixed here and never added to,
     which is what keeps new business out of NRR. */
  for (const [customerId, was] of startMap) {
    startingMrr += was;
    const now = endMap.get(customerId) ?? 0;
    endingCohortMrr += now;

    if (now === 0) {
      churned += was;
      counts.churned++;
    } else if (now > was) {
      expansion += now - was;
      counts.expanded++;
      counts.retained++;
    } else if (now < was) {
      contraction += was - now;
      counts.contracted++;
      counts.retained++;
    } else {
      counts.retained++;
    }
  }

  /* Everyone paying now who was not in the cohort. Reported separately — see the
     header on why this must never reach NRR. */
  for (const [customerId, now] of endMap) {
    if (!startMap.has(customerId)) {
      newMrr += now;
      counts.new++;
    }
  }

  /* Reactivation is a subset of `new` by this calculation — a customer absent from
     `start` looks new whether or not they were here a year ago. Distinguishing them
     needs history beyond two points, so it is reported as zero rather than guessed
     from the two snapshots in hand. `reactivatedMrr` exists for when a caller can
     supply that history; inventing it from two points would be a made-up split. */
  const reactivatedMrr = 0;

  return {
    startingMrr,
    endingCohortMrr,
    expansion,
    contraction,
    churned,
    newMrr,
    reactivatedMrr,
    /* Null, not 100%, when there was nothing to retain. An empty comparison
       arithmetically yields 1.0, which on screen reads as perfect retention. */
    nrrBps: startingMrr > 0 ? Math.round((endingCohortMrr / startingMrr) * 10_000) : null,
    grrBps: startingMrr > 0
      ? Math.round(((startingMrr - contraction - churned) / startingMrr) * 10_000)
      : null,
    counts,
  };
}

/**
 * The identity NRR must satisfy.
 *
 * ending = start + expansion − contraction − churn. Exported and tested because a
 * future change to the bucketing could break it silently, and a retention figure
 * whose parts do not reconcile is worse than none — it looks authoritative.
 */
export function reconciles(r: RetentionResult): boolean {
  return r.endingCohortMrr === r.startingMrr + r.expansion - r.contraction - r.churned;
}

export type RetentionVerdict = "excellent" | "healthy" | "leaking" | "bleeding" | "unknown";

/** How to read the number, in one word plus a sentence. */
export function retentionVerdict(r: RetentionResult): { verdict: RetentionVerdict; message: string } {
  if (r.nrrBps == null) {
    return {
      verdict: "unknown",
      message: "No revenue at the start of this period, so there is nothing to have retained.",
    };
  }
  const pct = r.nrrBps / 100;
  if (pct >= 110) {
    return { verdict: "excellent", message: `Existing customers grew ${(pct - 100).toFixed(1)}% — expansion is outrunning every loss.` };
  }
  if (pct >= 100) {
    return { verdict: "healthy", message: "Existing customers are worth at least what they were — growth does not depend on new logos." };
  }
  if (pct >= 90) {
    return { verdict: "leaking", message: `Existing customers shrank ${(100 - pct).toFixed(1)}%. New business is covering it, which hides the leak until it cannot.` };
  }
  return { verdict: "bleeding", message: `Existing customers shrank ${(100 - pct).toFixed(1)}%. At this rate the base halves before new business can replace it.` };
}

/** Format basis points as a percentage string. */
export function fmtBps(bps: number | null): string {
  if (bps == null) return "—";
  const pct = bps / 100;
  return `${pct.toFixed(pct % 1 === 0 ? 0 : 1)}%`;
}
