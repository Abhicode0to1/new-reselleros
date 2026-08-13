/**
 * Lead "heat" — the single source of truth for what makes a lead high-value or
 * hot. Shared by the Leads list (row tags + rails), the smart-view chips, and
 * the view filters so the count on a chip ALWAYS matches the tagged rows.
 * (Before this, the Hot chip counted stage while the row tag used priority —
 * so the inbox could show "Hot 0" with Hot-tagged rows. This file fixes that.)
 */
import type { Lead } from "@/lib/supabase/database.types";

/** A lead worth ≥ ₹1 lakh gets the emerald high-value treatment. */
export const HIGH_VALUE = 100_000;

export function isHighValueLead(l: Pick<Lead, "value">): boolean {
  return (l.value ?? 0) >= HIGH_VALUE;
}

/**
 * "Hot" = worth prioritising today. Two signals, unified so every surface
 * agrees:
 *   • priority = high  — the operator explicitly flagged it urgent, OR
 *   • stage in demo / trial / quote — advanced in the funnel, closest to a win.
 */
export function isHotLead(l: Pick<Lead, "priority" | "stage">): boolean {
  return (
    l.priority === "high" ||
    l.stage === "demo" ||
    l.stage === "trial" ||
    l.stage === "quote"
  );
}

/** Human reason a lead is hot — powers the "Hot" tag tooltip so it's never a
 *  mystery. Priority takes precedence when both signals are true. "" if not hot. */
export function hotReason(l: Pick<Lead, "priority" | "stage">): string {
  if (l.priority === "high") return "High priority";
  if (l.stage === "quote") return "Quote sent";
  if (l.stage === "trial") return "Trial active";
  if (l.stage === "demo") return "Demo done";
  return "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Intent tier + staleness (added 2026-08-13)
//
// One shared time signal feeds two features that would otherwise drift apart:
// the Cold tier of the Hot/Warm/Cold badge, and the "stale deal" warning. Both
// read `daysSinceTouch()`, so a lead can never be "Warm" and "8 days untouched"
// at the same time.
//
// Kept pure and separate from the React layer so the thresholds are testable and
// live in exactly one place — the same reason this file exists at all.
// ─────────────────────────────────────────────────────────────────────────────

/** A deal worth more than this counts as high-intent for the Hot tier. */
export const HOT_VALUE = 50_000;
/** No activity for this many days ⇒ Cold. */
export const COLD_DAYS = 10;
/** No activity for this many days ⇒ show the "needs action" warning. */
export const STALE_DAYS = 7;

export type IntentTier = "hot" | "warm" | "cold";

/** Stages that mean the deal has genuinely moved — used by the Hot test. */
const ADVANCED_STAGES: ReadonlySet<string> = new Set(["demo", "trial", "quote"]);

/**
 * Whole days since the lead was last touched.
 *
 * `lastActivityAt` should be the newest `lead_activities.created_at` when the
 * caller has it; otherwise `updated_at` is a fair proxy (the touch trigger
 * bumps it on every edit). Returns null when there is no usable timestamp —
 * callers must treat null as "unknown", never as "stale", or a freshly imported
 * lead with no history would be scolded on day one.
 */
export function daysSinceTouch(
  l: Pick<Lead, "updated_at" | "created_at">,
  lastActivityAt?: string | null,
  now: Date = new Date(),
): number | null {
  const stamp = lastActivityAt ?? l.updated_at ?? l.created_at;
  if (!stamp) return null;
  const then = new Date(stamp).getTime();
  if (Number.isNaN(then)) return null;
  const diff = now.getTime() - then;
  if (diff < 0) return 0;                       // clock skew — never negative
  return Math.floor(diff / 86_400_000);
}

/**
 * Hot / Warm / Cold.
 *
 * Order matters: Cold is checked FIRST. A ₹2L deal that nobody has touched in
 * three weeks is not "Hot" — it is the one most at risk, and calling it Hot is
 * exactly how it keeps getting ignored.
 *
 *   cold — untouched for COLD_DAYS+
 *   hot  — worth > HOT_VALUE and sitting in demo/trial/quote, or flagged high priority
 *   warm — everything else
 */
export function intentTier(
  l: Pick<Lead, "value" | "stage" | "priority" | "updated_at" | "created_at">,
  lastActivityAt?: string | null,
  now: Date = new Date(),
): IntentTier {
  const days = daysSinceTouch(l, lastActivityAt, now);
  if (days !== null && days >= COLD_DAYS) return "cold";
  const valuable = (l.value ?? 0) > HOT_VALUE;
  if (l.priority === "high") return "hot";
  if (valuable && ADVANCED_STAGES.has(l.stage ?? "")) return "hot";
  return "warm";
}

/** Label + tone + reason for the badge, so every surface renders it identically. */
export function intentMeta(
  l: Pick<Lead, "value" | "stage" | "priority" | "updated_at" | "created_at">,
  lastActivityAt?: string | null,
  now: Date = new Date(),
): { tier: IntentTier; label: string; kind: "danger" | "warning" | "info"; reason: string } {
  const tier = intentTier(l, lastActivityAt, now);
  const days = daysSinceTouch(l, lastActivityAt, now);
  if (tier === "cold") {
    return { tier, label: "Cold", kind: "info", reason: `No activity for ${days} days` };
  }
  if (tier === "hot") {
    const why = l.priority === "high" ? "High priority" : `${hotReason(l) || "Advanced stage"} · high value`;
    return { tier, label: "Hot", kind: "danger", reason: why };
  }
  return { tier, label: "Warm", kind: "warning", reason: "Active enquiry" };
}

/**
 * The "stale deal" warning (feature #5). Deliberately a SEPARATE threshold from
 * Cold: the nudge should arrive at STALE_DAYS, before the lead has gone properly
 * cold at COLD_DAYS, so there is a window to save it.
 *
 * Returns null when the lead is fine or its age is unknown.
 */
export function staleWarning(
  l: Pick<Lead, "stage" | "updated_at" | "created_at">,
  lastActivityAt?: string | null,
  now: Date = new Date(),
): { days: number; message: string } | null {
  // Closed deals are supposed to sit still.
  if (l.stage === "won" || l.stage === "lost") return null;
  const days = daysSinceTouch(l, lastActivityAt, now);
  if (days === null || days < STALE_DAYS) return null;
  return { days, message: `${days} days in ${stageLabel(l.stage)} — action needed` };
}

function stageLabel(stage: string | null | undefined): string {
  switch (stage) {
    case "new":     return "New";
    case "contact": return "Contacted";
    case "demo":    return "Demo";
    case "trial":   return "Trial";
    case "quote":   return "Quote Sent";
    default:        return "Pipeline";
  }
}
