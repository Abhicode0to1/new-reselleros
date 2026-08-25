/**
 * The arithmetic behind the SaaS-metrics charts — the MRR trend, and how fast cohorts decay.
 *
 * Separated from the drawing for the reason lib/accounting/pnl-charts.ts is: a chart built on
 * a wrong number renders perfectly and nobody can see it. Recharts does the pixels; the series
 * are computed here, with tests.
 *
 * ─── THE SOURCE IS `subscriptions`, AND `mrr_snapshots` WAS CHECKED FIRST ───
 * There is a `mrr_snapshots` table, written monthly by api/cron/mrr-snapshot, and it is the
 * obvious source for a trend line. It is EMPTY: 0 rows on production, measured 25 Aug 2026.
 * The cron exists in scripts/setup-cloud-scheduler.sh but that script has never been run, so
 * nothing has ever written to it.
 *
 * A trend chart reading an empty table renders a blank panel that looks like a bug rather than
 * like an unscheduled job. So the series is reconstructed from `subscriptions` instead — the
 * same rows every other number on that page comes from, which keeps ONE source rather than
 * two that can disagree. When the snapshot cron is finally scheduled, the honest move is to
 * switch this module to read it and delete the reconstruction, not to have both.
 *
 * ─── WHAT A RECONSTRUCTED TREND CANNOT SEE, STATED HERE AND ON THE CHART ────
 * Two limits, and neither is a rounding error:
 *
 *   1. IT USES TODAY'S MRR FOR EVERY PAST MONTH. `subscriptions.mrr` is a single current
 *      value; there is no history of seat changes. A customer who went 5 seats → 20 seats in
 *      June appears to have been worth 20 seats' MRR since the day they started. The trend
 *      therefore shows the SHAPE of the book growing, not what was actually billed.
 *   2. IT CANNOT SEE A DELETED SUBSCRIPTION. Only rows that exist today are counted, so a
 *      subscription that was created and hard-deleted never appears in any month.
 *
 * Both are surfaced by `trendCaveats()` and rendered next to the chart. A trend with silent
 * caveats is worse than no trend, because the owner acts on it.
 */

/** The subset of a subscription row this module needs. */
export interface SubLifespan {
  /** `subscriptions.start_date`, YYYY-MM-DD. */
  startDate: string;
  /** `subscriptions.mrr`, whole rupees per month. Null is treated as 0, not as unknown. */
  mrr: number | null;
  /** 'active' | 'paused' | 'expired' | 'cancelled'. */
  status: string;
  /**
   * `subscriptions.updated_at` — the CHURN-TIME PROXY, and it is a poor one.
   *
   * Subscriptions carry no cancellation date, and this field moves on any edit, so a
   * cancelled subscription that was touched last week looks like it churned last week. The
   * page's waterfall already states this caveat for its own 30-day churn figure; the trend
   * inherits it rather than inventing a cleaner-looking rule.
   */
  updatedAt: string;
}

export interface MrrPoint {
  /** "2026-05" — sortable, and the identity of the point. */
  monthKey: string;
  /** "Aug 2026" — what a person reads on the axis. */
  label: string;
  /** ₹ per month, whole rupees. */
  mrr: number;
  /** How many subscriptions were live that month. */
  active: number;
}

/* ── Month helpers. UTC throughout, because these are DATE columns and a local
      construction lets a timezone offset move a subscription into the wrong month. ── */

function monthKeyOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabelOf(d: Date): string {
  return d.toLocaleString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** Parse a YYYY-MM-DD (or ISO timestamp) into a UTC Date, or null if unusable. */
function parseUTC(value: string): Date | null {
  if (!value) return null;
  const iso = value.length === 10 ? `${value}T00:00:00Z` : value;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole months from a to b, by calendar rather than by 30-day arithmetic. */
export function monthsBetween(a: Date, b: Date): number {
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

/**
 * Monthly MRR, reconstructed from subscription lifespans.
 *
 * A subscription counts toward a month when it had started by the end of that month and had
 * not yet ended by its beginning. `active` and `paused` rows are treated as running through
 * today — a paused subscription is still on the book and still renews.
 *
 * `monthsBack` bounds the window. It returns the LAST `monthsBack` months up to and including
 * the month of `today`, always the same length, so an axis does not change width when a
 * subscription is added.
 */
export function mrrTrend(
  subs: readonly SubLifespan[],
  monthsBack: number,
  today: Date,
): MrrPoint[] {
  const points: MrrPoint[] = [];
  const span = Math.max(1, Math.floor(monthsBack));

  for (let i = span - 1; i >= 0; i--) {
    const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    /* Last instant of this month, so a subscription starting on the 31st still counts. */
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0, 23, 59, 59));

    let mrr = 0;
    let active = 0;

    for (const s of subs) {
      const start = parseUTC(s.startDate);
      if (!start || start > monthEnd) continue;

      const running = s.status === "active" || s.status === "paused";
      if (!running) {
        /* Ended. `updatedAt` is the only date this schema has for when — see SubLifespan.
           A row whose proxy date is unparseable is treated as having ended before the
           window, which UNDER-states the trend. That direction is chosen deliberately: an
           MRR line that overstates is the one an owner makes a plan on. */
        const ended = parseUTC(s.updatedAt);
        if (!ended || ended < cursor) continue;
      }

      mrr += s.mrr ?? 0;
      active += 1;
    }

    points.push({ monthKey: monthKeyOf(cursor), label: monthLabelOf(cursor), mrr, active });
  }

  return points;
}

/**
 * The caveats that must be rendered beside the trend.
 *
 * A function rather than a constant so it can say only what applies: telling an owner that
 * seat history is missing when no subscription has ever changed seats is noise, and noise is
 * how a reader learns to skip the caveats that matter.
 */
export function trendCaveats(subs: readonly SubLifespan[]): string[] {
  const notes: string[] = [
    "Reconstructed from the subscriptions on the book today — each month uses that " +
    "subscription's CURRENT monthly value, because seat changes are not dated. The shape is " +
    "real; the rupees in past months are today's rate.",
  ];

  const ended = subs.filter((s) => s.status !== "active" && s.status !== "paused");
  if (ended.length > 0) {
    notes.push(
      `${ended.length} ended subscription${ended.length === 1 ? "" : "s"} placed by ` +
      "last-updated date, which moves on any edit — so a churn can land in the wrong month.",
    );
  }

  return notes;
}

/* ── Retention ───────────────────────────────────────────────────────────── */

/** One cohort, as the SaaS-metrics page already computes it. */
export interface CohortInput {
  /** "2026-05". */
  monthKey: string;
  monthLabel: string;
  startedCount: number;
  retainedCount: number;
  retentionPct: number;
}

export interface RetentionPoint {
  monthKey: string;
  label: string;
  /** Whole months from the cohort's month to today. 0 = this month's cohort. */
  ageMonths: number;
  retentionPct: number;
  startedCount: number;
}

/**
 * Cohorts arranged by AGE rather than by calendar month.
 *
 * Age is what makes the curve readable: "cohorts still hold 90% after three months" is a
 * sentence about the business, while "May was 90%" is a sentence about May. Sorted oldest
 * cohort first so the x-axis runs left-to-right in the direction time does.
 */
export function retentionCurve(
  cohorts: readonly CohortInput[],
  today: Date,
): RetentionPoint[] {
  return cohorts
    .map((c) => {
      const start = parseUTC(`${c.monthKey}-01`);
      return {
        monthKey: c.monthKey,
        label: c.monthLabel,
        ageMonths: start ? Math.max(0, monthsBetween(start, today)) : 0,
        retentionPct: c.retentionPct,
        startedCount: c.startedCount,
      };
    })
    .sort((a, b) => b.ageMonths - a.ageMonths);
}

export interface RetentionVelocity {
  /**
   * Percentage points of retention lost per month of cohort age. Negative means losing.
   * NULL when it cannot honestly be computed — see the guard in the function.
   */
  pointsPerMonth: number | null;
  /** One sentence for a person: what this is, or why there is no number. */
  explanation: string;
  /** How many cohorts the fit used. */
  cohorts: number;
}

/**
 * The minimum number of distinct cohort AGES a slope can be fitted to.
 *
 * Two, because a line through one point is not a line. This is the guard that matters most in
 * this file: production on 25 Aug 2026 had all seven subscriptions starting in the SAME month,
 * all still active. Without this, the chart would draw a confident flat line at 100% and the
 * owner would read "retention is perfect" when the truth is "there is one month of data".
 */
export const MIN_COHORTS_FOR_VELOCITY = 2;

/**
 * How fast retention falls as a cohort ages — a least-squares slope over the curve.
 *
 * Returns null rather than 0 when it cannot be computed, and the two are not the same claim:
 * 0 means "cohorts are not decaying", null means "there is not enough history to say". A chart
 * that renders the second as the first is the most flattering possible lie about a young book.
 */
export function retentionVelocity(curve: readonly RetentionPoint[]): RetentionVelocity {
  const distinctAges = new Set(curve.map((p) => p.ageMonths));

  if (curve.length < MIN_COHORTS_FOR_VELOCITY || distinctAges.size < MIN_COHORTS_FOR_VELOCITY) {
    const when = curve.length === 1 ? ` Everything on the book started in ${curve[0].label}.` : "";
    return {
      pointsPerMonth: null,
      cohorts: curve.length,
      explanation:
        `Not enough history yet — retention velocity needs at least ${MIN_COHORTS_FOR_VELOCITY} ` +
        `monthly cohorts of different ages, and there ${curve.length === 1 ? "is" : "are"} ` +
        `${curve.length}.${when} This is not 0% churn; it is nothing to measure yet.`,
    };
  }

  /* Least squares over (ageMonths, retentionPct). Unweighted: a cohort of one subscription
     counts as much as a cohort of fifty. That is wrong for forecasting and right for this
     chart, whose question is "does retention fall with age", not "what will next quarter be" —
     and weighting would let one big month hide a pattern in all the others. */
  const n = curve.length;
  const meanX = curve.reduce((s, p) => s + p.ageMonths, 0) / n;
  const meanY = curve.reduce((s, p) => s + p.retentionPct, 0) / n;

  let num = 0;
  let den = 0;
  for (const p of curve) {
    num += (p.ageMonths - meanX) * (p.retentionPct - meanY);
    den += (p.ageMonths - meanX) ** 2;
  }

  /* den === 0 is already excluded by the distinct-ages guard; kept because a divide-by-zero
     here would render as NaN%, which looks like a bug in the chart rather than in the data. */
  if (den === 0) {
    return {
      pointsPerMonth: null,
      cohorts: n,
      explanation: "Every cohort is the same age, so there is no trend to fit.",
    };
  }

  const slope = num / den;
  const rounded = Math.round(slope * 10) / 10;

  return {
    pointsPerMonth: rounded,
    cohorts: n,
    explanation:
      rounded < 0
        ? `Cohorts lose about ${Math.abs(rounded)} percentage points of retention per month of age, across ${n} cohorts.`
        : rounded > 0
          ? `Older cohorts are retaining BETTER than younger ones by about ${rounded} points per month — usually a sign that recent months are still settling, not that retention improves with age.`
          : `Retention is flat across ${n} cohorts — age is not predicting churn.`,
  };
}
