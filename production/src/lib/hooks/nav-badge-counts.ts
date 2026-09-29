/**
 * The pure half of useNavBadges: nav_badges() counts → sidebar badge strings.
 *
 * Kept apart from the hook so it can be tested without a Supabase client. The rule is
 * the one the sidebar has always had: a badge only when the count is above zero, so a
 * clean day shows a clean sidebar.
 */

export interface NavBadges {
  leads?:        string;
  enquiries?:    string;
  deals?:        string;
  tasks?:        string;
  renewals?:     string;
  invoices?:     string;
  payments?:     string;
  quotes?:       string;
  support?:      string;
  whatsapp?:     string;
}

/** The keys nav_badges() returns (migration 20260928130000). */
export const NAV_BADGE_KEYS = [
  "leads", "enquiries", "deals", "tasks", "renewals", "invoices", "payments", "quotes",
] as const;

export function badgesFromCounts(counts: unknown): NavBadges {
  const badges: NavBadges = {};
  if (!counts || typeof counts !== "object") return badges;
  const row = counts as Record<string, unknown>;
  for (const key of NAV_BADGE_KEYS) {
    const n = Number(row[key] ?? 0);
    if (Number.isFinite(n) && n > 0) badges[key] = String(Math.trunc(n));
  }
  return badges;
}
