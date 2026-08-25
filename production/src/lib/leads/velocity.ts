/**
 * Pipeline velocity — how long deals sit, and which ones have stopped moving.
 *
 * ─── WHY THIS NEEDED A NEW COLUMN ───────────────────────────────────────────
 * "5 days in Quote Sent" cannot be derived from anything the database held before
 * migration 20260816100506:
 *   • `updated_at` bumps on ANY edit, so correcting a phone number makes a deal that has
 *     been stuck for three weeks read as one day old — wrong in the worst direction,
 *     since it makes the stalest deals look the freshest.
 *   • `activity_log` records only that an update happened, not which column moved.
 * So `stage_changed_at` records the fact instead of inferring it from a proxy.
 *
 * ─── NULL MEANS UNKNOWN, AND IS RENDERED AS UNKNOWN ─────────────────────────
 * Existing leads that were not at `new` when the column landed have no stamp. They show
 * "—", not "0d" and not a number derived from updated_at. A stage age that is confidently
 * wrong is worse than one that is honestly absent: the whole feature exists to decide
 * which deals to chase.
 */
import type { Lead } from "@/lib/supabase/database.types";
import { isOpenStage } from "./forecast";

/** Days without a stage move before a deal is called stale. The brief's figure. */
export const STAGE_SLA_DAYS = 7;

export type StageAge = {
  /** Whole days in the current stage. Null when stage_changed_at was never recorded. */
  days: number | null;
  /** True when past the SLA and still open. */
  stale: boolean;
  /** Short badge text, e.g. "5d in Quote Sent" or "—". */
  label: string;
  /** Long-form, for a title attribute. Always says something useful. */
  title: string;
};

const STAGE_LABEL: Readonly<Record<Lead["stage"], string>> = {
  new: "New", contact: "Contacted", demo: "Demo Done",
  trial: "Trial Active", quote: "Quote Sent", won: "Won", lost: "Lost",
};

type VelocityLead = Pick<Lead, "stage"> & { stage_changed_at?: string | null };

/** Whole days between a timestamp and now. Null on a missing or unparseable stamp. */
export function daysInStage(
  l: VelocityLead, now: Date = new Date(),
): number | null {
  if (!l.stage_changed_at) return null;
  const then = new Date(l.stage_changed_at).getTime();
  if (Number.isNaN(then)) return null;
  const diff = now.getTime() - then;
  // Clock skew: a stamp in the future is 0 days old, never negative.
  return diff < 0 ? 0 : Math.floor(diff / 86_400_000);
}

export function stageAge(
  l: VelocityLead, now: Date = new Date(), slaDays: number = STAGE_SLA_DAYS,
): StageAge {
  const days = daysInStage(l, now);
  const stageName = STAGE_LABEL[l.stage] ?? l.stage;

  if (days === null) {
    return {
      days: null, stale: false, label: "—",
      title: `No stage-change date recorded for this deal yet. It will appear the next time the stage moves. (updated_at is not used here — it bumps on any edit, so it would report a stalled deal as fresh.)`,
    };
  }

  /* Closed deals are never stale. A won deal sitting in `won` for 90 days is not a
     problem, and flagging it would train people to ignore the badge. */
  const stale = isOpenStage(l.stage) && days >= slaDays;

  /* `1 days` was showing on any lead one day into a stage. */
  const d = days === 1 ? "1 day" : `${days} days`;

  return {
    days,
    stale,
    label: `${days}d in ${stageName}`,
    title: stale
      ? `${d} in ${stageName} with no stage movement — past the ${slaDays}-day mark. Either it moved and nobody recorded it, or it needs a nudge.`
      : `${d} in ${stageName}.`,
  };
}

export interface StageVelocity {
  stage: Lead["stage"];
  /** Open deals currently sitting in this stage with a known age. */
  measured: number;
  /** Open deals in this stage whose age is unknown — reported, not silently dropped. */
  unknown: number;
  /** Mean days in stage across the measured ones. Null when none are measurable. */
  avgDays: number | null;
  /** How many of the measured ones are past the SLA. */
  staleCount: number;
}

/**
 * Average time-in-stage across the open pipeline.
 *
 * This measures deals CURRENTLY sitting in each stage, not historical transit time —
 * the database has no stage history to compute the latter from, and inventing one from
 * `updated_at` would be the same mistake this module exists to avoid. What it answers is
 * "how long has work been piling up here", which is the question a stalled pipeline
 * actually poses.
 */
export function stageVelocity(
  leads: readonly VelocityLead[], now: Date = new Date(), slaDays: number = STAGE_SLA_DAYS,
): StageVelocity[] {
  const ORDER: Lead["stage"][] = ["new", "contact", "demo", "trial", "quote"];
  const acc = new Map<Lead["stage"], { total: number; measured: number; unknown: number; stale: number }>();

  for (const l of leads) {
    if (!isOpenStage(l.stage)) continue;
    const slot = acc.get(l.stage) ?? { total: 0, measured: 0, unknown: 0, stale: 0 };
    const d = daysInStage(l, now);
    if (d === null) slot.unknown++;
    else {
      slot.measured++;
      slot.total += d;
      if (d >= slaDays) slot.stale++;
    }
    acc.set(l.stage, slot);
  }

  return ORDER
    .filter((s) => acc.has(s))
    .map((s) => {
      const a = acc.get(s)!;
      return {
        stage: s,
        measured: a.measured,
        unknown: a.unknown,
        avgDays: a.measured > 0 ? Math.round(a.total / a.measured) : null,
        staleCount: a.stale,
      };
    });
}

/** Open deals past the SLA, worst first. The re-engagement worklist. */
export function staleDeals<T extends VelocityLead>(
  leads: readonly T[], now: Date = new Date(), slaDays: number = STAGE_SLA_DAYS,
): T[] {
  return leads
    .filter((l) => stageAge(l, now, slaDays).stale)
    .sort((a, b) => (daysInStage(b, now) ?? 0) - (daysInStage(a, now) ?? 0));
}
