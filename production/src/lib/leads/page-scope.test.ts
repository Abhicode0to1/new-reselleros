import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  everythingCountForPage, scopeFiltersForPage, stageShownOnPage,
} from "@/lib/leads/page-scope";
import { toLeadCountsFilters, toListLeadsFilters, type LeadListFilters } from "@/lib/leads/list-page";

/* R-057 (Pardeep, 30 Sep 2026): "Won leads sirf Deals page par (Leads page se hatao)".
   /leads listed won deals and counted them in "All leads 37" while its Filter offered only
   New / Contacted. These pin the params both RPCs receive on each page. */

const base: LeadListFilters = { smart_view: "everything", folder: "all", owner_ids: ["u1"] };

describe("R-057 — Leads page leaves out won; Deals page keeps it", () => {
  it("Leads page: list_leads and lead_counts params carry stages without won", () => {
    const f = scopeFiltersForPage(base, false);
    const list = toListLeadsFilters(f);
    const counts = toLeadCountsFilters(f);
    for (const p of [list, counts]) {
      expect(p.stages).toBeDefined();
      expect(p.stages).not.toContain("won");
      expect(p.stages).toEqual(expect.arrayContaining(["new", "contact", "demo", "trial", "quote", "lost"]));
    }
  });

  it("Leads page: a stage pick is kept, minus won; a won-only pick cannot bring won back", () => {
    expect(toListLeadsFilters(scopeFiltersForPage({ ...base, stages: ["new"] }, false)).stages).toEqual(["new"]);
    expect(toListLeadsFilters(scopeFiltersForPage({ ...base, stages: ["new", "won"] }, false)).stages).toEqual(["new"]);
    const wonOnly = toListLeadsFilters(scopeFiltersForPage({ ...base, stages: ["won"] }, false));
    expect(wonOnly.stages?.length).toBeGreaterThan(0);
    expect(wonOnly.stages).not.toContain("won");
  });

  it("Deals page: params unchanged — no stage constraint, so won is still listed and counted", () => {
    const f = scopeFiltersForPage(base, true);
    expect(toListLeadsFilters(f).stages).toBeUndefined();
    expect(toLeadCountsFilters(f).stages).toBeUndefined();
    expect(toListLeadsFilters(scopeFiltersForPage({ ...base, stages: ["won"] }, true)).stages).toEqual(["won"]);
  });

  it("stageShownOnPage: won only on /deals, lost on both", () => {
    expect(stageShownOnPage("won", false)).toBe(false);
    expect(stageShownOnPage("won", true)).toBe(true);
    expect(stageShownOnPage("lost", false)).toBe(true);
    expect(stageShownOnPage("new", false)).toBe(true);
  });

  it('"All leads" count: Leads page subtracts the won leads of the same base; Deals page does not', () => {
    const counts = { workspace: { junk: 2, everything: 37, suspects: 0 },
      kpi: { open_count: 30, open_value: 0, open_value_project: 0, won: 4, lost: 3 } };
    expect(everythingCountForPage(counts, false)).toBe(33);
    expect(everythingCountForPage(counts, true)).toBe(37);
  });

  it("the page sends the scoped filters to BOTH readers", () => {
    const src = readFileSync(join(process.cwd(), "src", "app", "(app)", "leads", "page.tsx"), "utf8");
    expect(src).toMatch(/listFilters = React\.useMemo<LeadListFilters>\(\(\) => scopeFiltersForPage\(\{/);
    expect(src).toMatch(/\}, isDealsPage\), \[/);
    expect(src).toContain("useLeadCounts(listFilters)");
    expect(src).toContain("useLeadsInfinite(listFilters,");
    expect(src).toContain("everythingCount={everythingCountForPage(counts, isDealsPage)}");
  });
});
