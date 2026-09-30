/**
 * /deals — the Deal Pipeline page.
 *
 * Re-uses the same component as /leads; it reads usePathname() and switches mode. The split
 * is BY STAGE, and lives in lib/leads/page-scope.ts (one rule, tested):
 *   /leads → every stage except won (R-057, 30 Sep 2026)
 *   /deals → quote / demo / trial / won / lost only — real deals. New and Contacted are
 *            leads and stay on /leads (Deals audit, 30 Sep 2026).
 * Both the list (list_leads) and every count (lead_counts) receive the page's `stages`, and
 * the board reads only this page's columns — so /deals has no New / Contacted column.
 *
 * Earlier versions of this comment said the split was "NULL-plan vs plan-set" (never true —
 * it was always stage) and that /deals held demo…lost while /leads held new/contact (true
 * once, then both pages showed every stage until this audit).
 *
 * Access: no role gate any more (nav.ts; Pardeep, 17 Aug 2026) — every sales user can open it.
 */
export { default } from "../leads/page";
