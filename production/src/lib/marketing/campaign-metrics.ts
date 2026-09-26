/**
 * Marketing campaign arithmetic — budget use, pace, cost per lead / deal, target progress.
 *
 * Pure, so the page and its tests agree. Spend is what was booked against the campaign
 * (expenses.campaign_id); leads are those whose utm_campaign is the campaign's code.
 *
 * "Pace" answers the question an owner actually asks mid-campaign: at this rate, will the
 * budget run out early or be left unspent? It compares spend so far with a straight-line
 * share of the budget for the days elapsed.
 */

export type CampaignPhase = "upcoming" | "running" | "ended" | "cancelled";

export interface CampaignInput {
  start_date: string;          // YYYY-MM-DD
  end_date: string;
  budget: number;
  target_leads: number | null;
  target_won: number | null;
  cancelled: boolean;
}

export interface CampaignActuals {
  spend: number;
  leads: number;
  won: number;
  wonValue: number;
}

export interface CampaignMetrics {
  phase: CampaignPhase;
  days: number;               // campaign length, inclusive
  daysElapsed: number;        // 0 before start, `days` after end
  budgetUsedPct: number | null;          // null when there is no budget
  /** Spend minus the straight-line share for the days elapsed. >0 = ahead of plan. */
  paceGap: number | null;
  pace: "on_track" | "overspending" | "underspending" | null;
  overBudget: boolean;
  costPerLead: number | null;
  costPerWon: number | null;
  /** Won value ÷ spend. Null when nothing was spent. */
  roas: number | null;
  leadsPct: number | null;
  wonPct: number | null;
}

const DAY = 86_400_000;
const toUtc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));

export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Tolerance before pace is called off-plan: 15% of the budget share so far. */
const PACE_TOLERANCE = 0.15;

export function campaignMetrics(c: CampaignInput, a: CampaignActuals, today: string = todayIso()): CampaignMetrics {
  const s = toUtc(c.start_date), e = toUtc(c.end_date), t = toUtc(today);
  const days = Math.max(1, Math.round((e - s) / DAY) + 1);
  const daysElapsed = t < s ? 0 : t > e ? days : Math.round((t - s) / DAY) + 1;
  const phase: CampaignPhase = c.cancelled ? "cancelled" : t < s ? "upcoming" : t > e ? "ended" : "running";

  const budget = Math.max(0, c.budget || 0);
  const spend = Math.max(0, a.spend || 0);
  const budgetUsedPct = budget > 0 ? Math.round((spend / budget) * 100) : null;

  let paceGap: number | null = null;
  let pace: CampaignMetrics["pace"] = null;
  if (budget > 0 && phase === "running") {
    const planned = (budget * daysElapsed) / days;
    paceGap = Math.round(spend - planned);
    const tol = Math.max(planned * PACE_TOLERANCE, 1);
    pace = paceGap > tol ? "overspending" : paceGap < -tol ? "underspending" : "on_track";
  }

  const pct = (n: number, target: number | null) => (target && target > 0 ? Math.round((n / target) * 100) : null);

  return {
    phase, days, daysElapsed, budgetUsedPct, paceGap, pace,
    overBudget: budget > 0 && spend > budget,
    costPerLead: a.leads > 0 && spend > 0 ? Math.round(spend / a.leads) : null,
    costPerWon: a.won > 0 && spend > 0 ? Math.round(spend / a.won) : null,
    roas: spend > 0 ? Math.round((a.wonValue / spend) * 10) / 10 : null,
    leadsPct: pct(a.leads, c.target_leads),
    wonPct: pct(a.won, c.target_won),
  };
}

/** Link-safe code from a name, the same shape tracking links use ("Diwali Offer 2026" → "diwali-offer-2026"). */
export function campaignCode(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
}
