/**
 * Why deals are lost — the fixed reason set, plus the rollup the owner actually
 * reads ("we lost ₹4.2L to price this quarter").
 *
 * Pure and separate from React so the codes here and the CHECK constraint in
 * migration 0225 can be kept in step, and so the analytics can be tested without
 * a database. Keep LOSS_REASONS in sync with `leads_lost_reason_check`.
 */
import type { Lead } from "@/lib/supabase/database.types";

export type LossReasonCode =
  | "price" | "competitor" | "no_response" | "timing" | "not_qualified" | "other";

export interface LossReason {
  code: LossReasonCode;
  /** Button label — phrased as the seller would say it out loud. */
  label: string;
  /** One-line clarification, so two people pick the same code for the same loss. */
  hint: string;
}

/**
 * Order matters: this is the click order in the dialog, so the most common
 * reasons sit first and the capture stays genuinely one-click.
 */
export const LOSS_REASONS: readonly LossReason[] = [
  { code: "price",         label: "Price too high",   hint: "Budget or our rate was the blocker" },
  { code: "competitor",    label: "Chose competitor", hint: "Went with another reseller or vendor" },
  { code: "no_response",   label: "No response",      hint: "Went dark — no reply after follow-ups" },
  { code: "timing",        label: "Bad timing",       hint: "Real interest, wrong moment — worth revisiting" },
  { code: "not_qualified", label: "Not a fit",        hint: "Never a real prospect for us" },
  { code: "other",         label: "Other",            hint: "Add a note below" },
] as const;

const CODES = new Set(LOSS_REASONS.map((r) => r.code));

export function isLossReason(v: unknown): v is LossReasonCode {
  return typeof v === "string" && CODES.has(v as LossReasonCode);
}

/** Display label for a stored code. Unknown/absent ⇒ honest "Not recorded". */
export function lossReasonLabel(code: string | null | undefined): string {
  if (!code) return "Not recorded";
  const hit = LOSS_REASONS.find((r) => r.code === code);
  return hit ? hit.label : "Not recorded";
}

export interface LossBreakdownRow {
  code: LossReasonCode | "unrecorded";
  label: string;
  count: number;
  /** Pipeline value lost to this reason — the number that gets attention. */
  value: number;
  /** Share of lost COUNT, 0-100, rounded. */
  pct: number;
}

/**
 * Group lost deals by reason, biggest-value first.
 *
 * Deals lost before the reason was captured are reported as "Not recorded"
 * rather than dropped — hiding them would make the percentages read as if every
 * loss had been explained, which is exactly the false confidence this feature
 * is meant to remove.
 *
 * @param since optional cutoff; uses `lost_at` and skips rows without one.
 */
export function lossBreakdown(
  leads: ReadonlyArray<Pick<Lead, "stage" | "value"> & { lost_reason?: string | null; lost_at?: string | null }>,
  since?: Date,
): LossBreakdownRow[] {
  const lost = leads.filter((l) => {
    if (l.stage !== "lost") return false;
    if (!since) return true;
    if (!l.lost_at) return false;                 // undated → outside any window
    const t = new Date(l.lost_at).getTime();
    return !Number.isNaN(t) && t >= since.getTime();
  });

  const total = lost.length;
  const acc = new Map<string, { count: number; value: number }>();
  for (const l of lost) {
    const key = isLossReason(l.lost_reason) ? l.lost_reason : "unrecorded";
    const cur = acc.get(key) ?? { count: 0, value: 0 };
    cur.count += 1;
    cur.value += l.value ?? 0;
    acc.set(key, cur);
  }

  return [...acc.entries()]
    .map(([code, v]) => ({
      code: code as LossBreakdownRow["code"],
      label: code === "unrecorded" ? "Not recorded" : lossReasonLabel(code),
      count: v.count,
      value: v.value,
      pct: total > 0 ? Math.round((v.count / total) * 100) : 0,
    }))
    .sort((a, b) => b.value - a.value || b.count - a.count);
}
