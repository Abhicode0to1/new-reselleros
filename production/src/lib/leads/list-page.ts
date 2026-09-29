/**
 * The client half of `list_leads()` (migration 20260928200000, S37) — pure, tested.
 *
 * ─── WHAT THIS IS FOR, AND WHAT IT IS NOT YET WIRED TO ───────────────────────
 * `list_leads(p_cursor, p_limit, p_filters)` returns ONE keyset page of slim lead rows
 * (created_at desc, id desc) plus the cursor for the next page. `useLeadsInfinite()` in
 * lib/queries/leads.ts pages it with useInfiniteQuery.
 *
 * The Sales & Pipeline screen does NOT read it yet, on purpose: every count on that screen
 * (folder chips, smart views, junk suspects, duplicates, the board, the KPI tiles) and the
 * default "wait" sort are computed over the WHOLE lead set in the browser
 * (list-selectors.ts), and three layout panels (command palette, notifications, quick
 * actions) load that same full set on every page. Swapping only the list to pages would add
 * requests and remove none, and would make the list disagree with its own chips. The
 * filter keys below are the subset of searchLeads() the server can reproduce EXACTLY; the
 * SQL test (supabase/tests/list_rpcs.test.sql) and list-page.test.ts pin that parity so the
 * switch-over can happen view by view without a silent behaviour change.
 */
import type { Lead } from "@/lib/supabase/database.types";

/**
 * The columns list_leads() returns — must equal the migration's select list (checked by
 * list-rpcs-sql-copy.test.ts). Everything the row, card and counts read; none of the free
 * text that made select("*") heavy.
 */
export const LEAD_LIST_COLUMNS = [
  "id", "company", "contact_name", "contact_email", "contact_phone",
  "plan", "seats", "value", "stage", "priority", "owner_id", "source",
  "is_junk", "created_at", "updated_at", "follow_up_date", "expected_close_date",
  "stage_changed_at", "enquiry_type", "project_id", "customer_id",
  "requires_human_attention", "pipeline", "subscription_type", "lost_reason",
] as const satisfies readonly (keyof Lead)[];

export type LeadListRow = Pick<Lead, (typeof LEAD_LIST_COLUMNS)[number]>;

/** The keyset cursor, exactly as the server returned it — never rebuilt client-side. */
export interface LeadListCursor {
  created_at: string;
  id: string;
}

export interface LeadListPage {
  rows: LeadListRow[];
  next_cursor: LeadListCursor | null;
}

/** The server-expressible filters (see the migration's header for each key's rule). */
export interface LeadListFilters {
  search?: string;
  stages?: Lead["stage"][];
  priorities?: Array<"low" | "medium" | "high">;
  junk?: "exclude" | "only" | "any";
  /** Team view: these owners OR unowned. */
  owner_ids?: string[];
  /** Exactly this owner ("Mine"). */
  owner_id?: string;
  /** Not won, not lost, not junk. */
  open_only?: boolean;
}

/**
 * Build `p_filters` from page state, dropping every key that would mean "no constraint", so
 * two equivalent states give the same JSON — and therefore the same query key.
 *
 * `search` is sent AS TYPED when it has any non-blank character (the page matches untrimmed
 * text too), and omitted when it is blank.
 */
export function toListLeadsFilters(input: LeadListFilters): LeadListFilters {
  const out: LeadListFilters = {};
  if (input.search !== undefined && input.search.trim() !== "") out.search = input.search;
  if (input.stages && input.stages.length > 0) out.stages = [...input.stages].sort();
  if (input.priorities && input.priorities.length > 0) out.priorities = [...input.priorities].sort();
  if (input.junk && input.junk !== "exclude") out.junk = input.junk;
  if (input.owner_ids) out.owner_ids = [...input.owner_ids].sort();
  if (input.owner_id) out.owner_id = input.owner_id;
  if (input.open_only) out.open_only = true;
  return out;
}

/**
 * The server rule, in TypeScript, for a row that is already in memory — the parity oracle
 * the tests hold both sides to. Mirrors the migration's WHERE clause key by key.
 */
export function matchesListLeadsFilters(l: LeadListRow, f: LeadListFilters): boolean {
  const junk = f.junk ?? "exclude";
  if (junk === "exclude" && l.is_junk) return false;
  if (junk === "only" && !l.is_junk) return false;
  if (f.search !== undefined && f.search.trim() !== "") {
    const s = f.search.toLowerCase();
    const hit =
      l.company.toLowerCase().includes(s) ||
      (l.contact_name?.toLowerCase().includes(s) ?? false) ||
      (l.contact_email?.toLowerCase().includes(s) ?? false) ||
      (l.contact_phone?.toLowerCase().includes(s) ?? false) ||
      (l.plan?.toLowerCase().includes(s) ?? false);
    if (!hit) return false;
  }
  if (f.stages && f.stages.length > 0 && !f.stages.includes(l.stage)) return false;
  if (f.priorities && f.priorities.length > 0 && !f.priorities.includes(l.priority as "low" | "medium" | "high")) return false;
  if (f.owner_ids && l.owner_id && !f.owner_ids.includes(l.owner_id)) return false;
  if (f.owner_id && l.owner_id !== f.owner_id) return false;
  if (f.open_only && (l.stage === "won" || l.stage === "lost" || l.is_junk)) return false;
  return true;
}
