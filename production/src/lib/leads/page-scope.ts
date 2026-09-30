/**
 * Which stages each Sales page holds.
 *
 * R-057 (Pardeep, 30 Sep 2026): "Won leads sirf Deals page par (Leads page se hatao)".
 * Deals audit (30 Sep 2026): the Deals page is only REAL deals — quote, demo, trial, won,
 * lost (lib/leads/deal-rules.ts#DEALS_PAGE_STAGES). New / Contacted stay on /leads.
 *
 * /leads and /deals are one component over one table (see (app)/leads/page.tsx). Each page
 * sends its own `stages` list to BOTH list_leads() and lead_counts(), so the rows and every
 * server count that reads the searched set (folders, list.matching, hot card) agree.
 *
 * The one count lead_counts() takes before any filter — workspace.everything, the "All
 * leads" entry — is corrected per page: /leads subtracts kpi.won (same base); /deals sums its
 * own folders (quoted + proving + won + lost), which ARE counted over the stage-scoped set.
 * That sum narrows with search / filters like the list does; an un-narrowed deals-only
 * count, and View-menu counts (lead_counts().views) scoped to deal stages, need a change to
 * lead_counts() — a migration, not done here.
 *
 * Lost stays on /leads too: the R-057 decision named Won only.
 */
import type { Lead } from "@/lib/supabase/database.types";
import type { LeadCounts, LeadListFilters } from "@/lib/leads/list-page";
import type { SalesFolder } from "@/lib/leads/folders";
import { STAGE_LABEL } from "@/lib/leads/stage-meta";
import { DEALS_PAGE_STAGES } from "@/lib/leads/deal-rules";

/** Stages that never show on the Leads page — they live on /deals only. */
export const LEADS_PAGE_HIDDEN_STAGES: readonly Lead["stage"][] = ["won"];

const ALL_STAGES = Object.keys(STAGE_LABEL) as Lead["stage"][];

/** May a lead in this stage appear on this page? */
export function stageShownOnPage(stage: Lead["stage"], isDealsPage: boolean): boolean {
  return isDealsPage ? DEALS_PAGE_STAGES.includes(stage) : !LEADS_PAGE_HIDDEN_STAGES.includes(stage);
}

/** Every stage this page can show. */
export function pageStages(isDealsPage: boolean): Lead["stage"][] {
  return ALL_STAGES.filter((s) => stageShownOnPage(s, isDealsPage));
}

/**
 * The page's filters as sent to list_leads() and lead_counts(): `stages` becomes the picked
 * stages (or every stage the page shows when none is picked) minus the ones this page does
 * not show. A pick of only hidden stages falls back to "every shown stage" — an empty
 * `stages` means "no constraint" to the server, which would bring them back.
 */
export function scopeFiltersForPage(f: LeadListFilters, isDealsPage: boolean): LeadListFilters {
  const picked = (f.stages ?? []).filter((s) => stageShownOnPage(s, isDealsPage));
  const stages = picked.length > 0 ? picked : pageStages(isDealsPage);
  return { ...f, stages };
}

/** Folders whose stage cannot be on this page (Inbox = new, Talks = contact on /deals). */
export function folderShownOnPage(id: SalesFolder, isDealsPage: boolean): boolean {
  if (isDealsPage) return id !== "inbox" && id !== "talks";
  return id !== "won";
}

/**
 * The "All leads" / "Saari deals" count for this page. See the header for the two rules.
 */
export function everythingCountForPage(
  counts: Pick<LeadCounts, "workspace" | "kpi" | "folders">, isDealsPage: boolean,
): number {
  if (isDealsPage) {
    const f = counts.folders;
    return f.quoted + f.proving + f.won + f.lost;
  }
  return counts.workspace.everything - counts.kpi.won;
}
