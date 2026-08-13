/**
 * Peer kudos and achievement badges — the two things the existing performance
 * system did not have.
 *
 * ─── WHY THIS IS AN ADDITION AND NOT A REPLACEMENT ───────────────────────────
 * `lib/queries/performance.ts` already scores outcomes (revenue collected, deals
 * won, quotes, on-time tasks) against `PERF_WEIGHTS`, already floors the score at
 * zero, already shows a per-person breakdown, and already converts to cash by
 * splitting a bonus pool proportionally to score. That pool model is better than
 * a fixed ₹-per-point rate for one specific reason: **the payout is bounded by
 * what the business decided to spend.** A rate of ₹1/point costs whatever the
 * month happens to produce.
 *
 * So this file adds kudos and badges to that system rather than starting a
 * second scoring engine beside it. Two scoring engines in one app is the
 * second-source-of-truth failure, and it decides people's pay.
 *
 * ─── ONE THING STILL WORTH FIXING IN PERF_WEIGHTS ────────────────────────────
 * `paymentRecorded: 5` pays per payment ROW, and staff choose how to record a
 * collection. Measured against real weights:
 *
 *     one payment of ₹1,00,000        →  5 + (100000/5000)  =  25 pts
 *     the same ₹1,00,000 as 10 × ₹10k →  50 + 20            =  70 pts
 *
 * Same rupees, 2.8× the score, and score becomes cash. Setting
 * `paymentRecorded: 0` removes the incentive to split a receipt and costs
 * nothing else, because the revenue component already rewards collecting. Left
 * unchanged here because the weights are Pardeep's call — flagged, not altered.
 */

// ─── Peer kudos ─────────────────────────────────────────────────────────────

/** Points a single kudos is worth. */
export const KUDOS_POINTS = 10;

/**
 * How many kudos one person may award per period.
 *
 * Uncapped kudos is not a compliment, it is a currency two colleagues can print:
 * awarding each other ten a day is 300 points a month each, and points are cash.
 * A budget makes kudos scarce, which is the only thing that makes it a signal.
 */
export const KUDOS_PER_GIVER_PER_PERIOD = 10;

export interface KudosRow {
  /** Who receives the points. */
  userId: string;
  /** Who awarded them. */
  awardedBy: string;
  createdAt: string;
}

export interface KudosStanding {
  points: number;
  received: number;
  /** Distinct people who awarded — a count alone is one friend clicking twice. */
  distinctGivers: number;
}

export interface KudosTally {
  byUser: Record<string, KudosStanding>;
  /** Kudos that did not count, and why, so nothing disappears unexplained. */
  rejectedOverBudget: number;
  rejectedSelf: number;
}

function timeOf(v: string): number {
  const n = new Date(v).getTime();
  return Number.isFinite(n) ? n : 0;
}

/**
 * Tally kudos for a period, enforcing the per-giver budget.
 *
 * Processed oldest-first so "the first ten kudos of the period count" is a
 * stable fact rather than an artefact of row order from the database — the same
 * input in a different order must produce the same standings.
 */
export function tallyKudos(rows: KudosRow[]): KudosTally {
  const byUser: Record<string, KudosStanding> = {};
  const givers: Record<string, Set<string>> = {};
  const spent  = new Map<string, number>();
  let rejectedOverBudget = 0;
  let rejectedSelf = 0;

  const ordered = [...rows].sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt));

  for (const r of ordered) {
    if (!r.userId || !r.awardedBy) { rejectedSelf++; continue; }
    if (r.userId === r.awardedBy)  { rejectedSelf++; continue; }

    const used = spent.get(r.awardedBy) ?? 0;
    if (used >= KUDOS_PER_GIVER_PER_PERIOD) { rejectedOverBudget++; continue; }
    spent.set(r.awardedBy, used + 1);

    const s = byUser[r.userId] ?? { points: 0, received: 0, distinctGivers: 0 };
    const g = givers[r.userId] ?? new Set<string>();
    g.add(r.awardedBy);
    givers[r.userId] = g;

    byUser[r.userId] = {
      points: s.points + KUDOS_POINTS,
      received: s.received + 1,
      distinctGivers: g.size,
    };
  }

  return { byUser, rejectedOverBudget, rejectedSelf };
}

/** Remaining kudos budget for one giver in the period. */
export function kudosBudgetLeft(rows: KudosRow[], giverId: string): number {
  const used = rows.filter((r) => r.awardedBy === giverId && r.userId !== r.awardedBy).length;
  return Math.max(0, KUDOS_PER_GIVER_PER_PERIOD - used);
}

// ─── Badges ─────────────────────────────────────────────────────────────────

export interface BadgeDef {
  id: string;
  label: string;
  /** What earns it, in the words shown to the team. */
  criterion: string;
  emoji: string;
}

export const BADGES: BadgeDef[] = [
  { id: "master_closer",     label: "Master Closer",       criterion: "1,000+ points this period",                    emoji: "🏆" },
  { id: "lightning",         label: "Lightning Responder", criterion: "10+ tasks completed on or before their due date", emoji: "⚡" },
  { id: "renewal_guardian",  label: "Renewal Guardian",    criterion: "5+ payments collected on renewal quotes",       emoji: "🛡️" },
  { id: "ultimate_teammate", label: "Ultimate Teammate",   criterion: "5+ kudos, from 3 or more different people",     emoji: "🤝" },
];

export interface BadgeInput {
  score: number;
  tasksOnTime: number;
  /** Payments against quotes flagged `is_renewal`. */
  renewalPayments: number;
  kudosReceived: number;
  distinctKudosGivers: number;
}

/**
 * Badges earned.
 *
 * `Ultimate Teammate` requires 3+ DIFFERENT givers on purpose. A bare count is
 * earnable by one colleague clicking five times, which turns a teamwork award
 * into a favour.
 */
export function badgesFor(input: BadgeInput): BadgeDef[] {
  const earned: string[] = [];
  if (input.score >= 1000)          earned.push("master_closer");
  if (input.tasksOnTime >= 10)      earned.push("lightning");
  if (input.renewalPayments >= 5)   earned.push("renewal_guardian");
  if (input.kudosReceived >= 5 && input.distinctKudosGivers >= 3) earned.push("ultimate_teammate");
  return BADGES.filter((b) => earned.includes(b.id));
}
