/**
 * Which stages each Sales page holds — R-057 (Pardeep, 30 Sep 2026): "Won leads sirf
 * Deals page par (Leads page se hatao)".
 *
 * /leads and /deals are one component over one table (see (app)/leads/page.tsx). Before
 * this, /leads listed won deals (Excel Technologies, manoj sharma…) while its Filter only
 * offered New / Contacted, and "All leads 37" counted them too. Now the Leads page sends a
 * `stages` list without `won` to BOTH list_leads() and lead_counts(), so the rows and every
 * server count that reads the searched set (folders, list.matching, hot card) agree. The
 * one count lead_counts() takes before any filter — workspace.everything, the "All leads"
 * entry — is corrected by kpi.won, which is counted over the same base (non-junk workspace).
 *
 * Lost stays on /leads: the decision named Won only, and nothing on this page pairs the two
 * as a hidden "closed" set (the "All leads" view is documented as open + won + lost).
 * The Deals page is untouched.
 */
import type { Lead } from "@/lib/supabase/database.types";
import type { LeadCounts, LeadListFilters } from "@/lib/leads/list-page";
import { STAGE_LABEL } from "@/lib/leads/stage-meta";

/** Stages that never show on the Leads page — they live on /deals only. */
export const LEADS_PAGE_HIDDEN_STAGES: readonly Lead["stage"][] = ["won"];

const ALL_STAGES = Object.keys(STAGE_LABEL) as Lead["stage"][];

/** May a lead in this stage appear on this page? */
export function stageShownOnPage(stage: Lead["stage"], isDealsPage: boolean): boolean {
  return isDealsPage || !LEADS_PAGE_HIDDEN_STAGES.includes(stage);
}

/**
 * The page's filters as sent to list_leads() and lead_counts(). On /deals: unchanged. On
 * /leads: `stages` becomes the picked stages (or every stage when none is picked) minus the
 * hidden ones. A pick of hidden stages only falls back to "every shown stage" — an empty
 * `stages` means "no constraint" to the server, which would bring won back.
 */
export function scopeFiltersForPage(f: LeadListFilters, isDealsPage: boolean): LeadListFilters {
  if (isDealsPage) return f;
  const picked = (f.stages ?? []).filter((s) => stageShownOnPage(s, false));
  const stages = picked.length > 0 ? picked : ALL_STAGES.filter((s) => stageShownOnPage(s, false));
  return { ...f, stages };
}

/**
 * The "All leads" count for this page. workspace.everything is every non-junk lead in the
 * team cut; kpi.won is the won ones among exactly those, so the difference is what the
 * Leads page's "All leads" list pages out.
 */
export function everythingCountForPage(
  counts: Pick<LeadCounts, "workspace" | "kpi">, isDealsPage: boolean,
): number {
  return isDealsPage ? counts.workspace.everything : counts.workspace.everything - counts.kpi.won;
}
