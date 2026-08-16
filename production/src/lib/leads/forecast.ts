/**
 * Weighted revenue forecast — what the open pipeline is actually worth.
 *
 * Open Pipeline adds up every open deal at full value. That number is useful for "how
 * much is in play" and useless for "how much will land": a ₹5L deal at `new` and a ₹5L
 * deal at `quote` are not the same money, and summing them says they are.
 *
 * The weighted forecast multiplies each deal by the probability its stage has earned.
 *
 * ─── THE PROBABILITIES ──────────────────────────────────────────────────────
 * Set by the brief, and they are a STARTING POINT, not measured truth. Nobody has yet
 * counted what share of this tenant's `demo` deals actually close. When there is enough
 * history, replace these with the measured rates — a forecast built on invented
 * percentages is a guess wearing a number's clothes, which is the exact failure this
 * codebase keeps producing. They live here, in one place, so that replacement is a
 * one-line change rather than an archaeology exercise.
 *
 * ─── WHAT THE FORECAST DELIBERATELY EXCLUDES ────────────────────────────────
 * `won` carries a 100% probability — it is certain — but won deals are NOT in the
 * forecast. A forecast answers "what is still to come"; folding in money already earned
 * inflates it every time somebody closes a deal, which is precisely backwards. `lost` is
 * 0% and excluded for the obvious reason.
 *
 * ─── MONEY ──────────────────────────────────────────────────────────────────
 * `leads.value` is whole RUPEES (an integer column). Weighting produces a fraction, so
 * each deal is rounded ONCE and the total is the sum of those — never the other way
 * round, or the rows on screen will not add up to the total above them.
 */
import type { Lead } from "@/lib/supabase/database.types";

/** Integer percent. 40 = 40%. */
export type Percent = number;

/**
 * Win probability by stage.
 *
 * `lost` is 0 and absent from the brief's list; it is here because leaving a stage out
 * of a lookup means the code silently picks a default for it, and a default of 10% on a
 * lost deal would quietly add money to a forecast.
 */
export const STAGE_PROBABILITY: Readonly<Record<Lead["stage"], Percent>> = {
  new:     10,
  contact: 20,
  demo:    40,
  trial:   60,
  quote:   80,
  won:    100,
  lost:     0,
};

/** Stages that are finished. Neither belongs in a forecast of what is still to come. */
const CLOSED: ReadonlySet<string> = new Set(["won", "lost"]);

export function isOpenStage(stage: Lead["stage"] | null | undefined): boolean {
  return !!stage && !CLOSED.has(stage);
}

export function stageProbability(stage: Lead["stage"] | null | undefined): Percent {
  if (!stage) return 0;
  return STAGE_PROBABILITY[stage] ?? 0;
}

/**
 * One deal's weighted value, in whole rupees.
 *
 * Rounded here, once. The forecast total is the sum of these, so the number in a row and
 * the number in the header always agree.
 */
export function weightedValue(l: Pick<Lead, "value" | "stage">): number {
  const value = l.value ?? 0;
  if (value <= 0) return 0;
  return Math.round((value * stageProbability(l.stage)) / 100);
}

export interface ForecastSlice {
  stage: Lead["stage"];
  count: number;
  /** Full rupee value of the deals in this stage. */
  openValue: number;
  /** Weighted rupee value. */
  weighted: number;
  probability: Percent;
}

export interface Forecast {
  /** Open deals only — won and lost are excluded. See the header. */
  openCount: number;
  /** Sum of `value` across open deals. The existing "Open Pipeline" figure. */
  openValue: number;
  /** Sum of each open deal's weighted value. */
  weighted: number;
  /** Weighted as a share of open, integer percent. Null when there is no open pipeline. */
  confidencePct: Percent | null;
  byStage: ForecastSlice[];
  /**
   * Open deals with no expected close date.
   *
   * Reported, never hidden. A forecast that silently drops undated deals reads as
   * "this is the whole picture" when a third of it may be missing — and the fix (ask the
   * rep for a date) only happens if somebody is told.
   */
  undatedCount: number;
  undatedValue: number;
}

type ForecastLead = Pick<Lead, "value" | "stage"> & { expected_close_date?: string | null };

/**
 * Roll up a set of leads. Junk is the caller's problem to filter — this function does
 * not know what a working view is.
 */
export function buildForecast(leads: readonly ForecastLead[]): Forecast {
  const open = leads.filter((l) => isOpenStage(l.stage));

  let openValue = 0;
  let weighted = 0;
  let undatedCount = 0;
  let undatedValue = 0;
  const byStageMap = new Map<Lead["stage"], ForecastSlice>();

  for (const l of open) {
    const v = l.value ?? 0;
    const w = weightedValue(l);
    openValue += v;
    weighted += w;

    if (!l.expected_close_date) { undatedCount++; undatedValue += v; }

    const slice = byStageMap.get(l.stage) ?? {
      stage: l.stage, count: 0, openValue: 0, weighted: 0,
      probability: stageProbability(l.stage),
    };
    slice.count++;
    slice.openValue += v;
    slice.weighted += w;
    byStageMap.set(l.stage, slice);
  }

  /* Ordered by how far through the funnel they are, not alphabetically — a forecast read
     top to bottom should walk towards the close. */
  const ORDER: Lead["stage"][] = ["new", "contact", "demo", "trial", "quote"];
  const byStage = ORDER.map((s) => byStageMap.get(s)).filter((s): s is ForecastSlice => !!s);

  return {
    openCount: open.length,
    openValue,
    weighted,
    confidencePct: openValue > 0 ? Math.round((weighted * 100) / openValue) : null,
    byStage,
    undatedCount,
    undatedValue,
  };
}

/**
 * Deals expected to close on or before a date, still open.
 *
 * Undated deals are NOT included: "closing this month" is a claim, and a deal nobody has
 * put a date on has not made it.
 */
export function closingBy(
  leads: readonly ForecastLead[], isoDate: string,
): ForecastLead[] {
  return leads.filter((l) =>
    isOpenStage(l.stage) && !!l.expected_close_date && l.expected_close_date <= isoDate);
}

/** Label for a probability badge, e.g. "80% · Quote Sent". */
export function probabilityLabel(stage: Lead["stage"] | null | undefined): string {
  if (!stage) return "—";
  return `${stageProbability(stage)}%`;
}
