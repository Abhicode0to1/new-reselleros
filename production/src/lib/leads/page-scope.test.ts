import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  everythingCountForPage, folderShownOnPage, pageStages, scopeFiltersForPage, stageShownOnPage,
} from "@/lib/leads/page-scope";
import { toLeadCountsFilters, toListLeadsFilters, type LeadListFilters } from "@/lib/leads/list-page";

/* R-057 (Pardeep, 30 Sep 2026): "Won leads sirf Deals page par (Leads page se hatao)".
   Deals audit (30 Sep 2026): /deals holds only real deals — quote, demo, trial, won, lost.
   These pin the params both RPCs receive on each page. */

const base: LeadListFilters = { smart_view: "everything", folder: "all", owner_ids: ["u1"] };
const folders = { inbox: 9, talks: 26, quoted: 4, proving: 3, won: 2, lost: 5, hot: 1, followup: 0 };

describe("R-057 — Leads page leaves out won", () => {
  it("Leads page: list_leads and lead_counts params carry stages without won", () => {
    const f = scopeFiltersForPage(base, false);
    for (const p of [toListLeadsFilters(f), toLeadCountsFilters(f)]) {
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

  it('"All leads" count on /leads subtracts the won leads of the same base', () => {
    const counts = { workspace: { junk: 2, everything: 37, suspects: 0 },
      kpi: { open_count: 30, open_value: 0, open_value_project: 0, won: 4, lost: 3 }, folders };
    expect(everythingCountForPage(counts, false)).toBe(33);
  });
});

describe("Deals page = only real deals (quote → won / lost)", () => {
  it("both RPCs get exactly the deal stages — no New / Contacted", () => {
    const f = scopeFiltersForPage(base, true);
    for (const p of [toListLeadsFilters(f), toLeadCountsFilters(f)]) {
      expect(p.stages).toEqual(["demo", "lost", "quote", "trial", "won"]);
    }
  });

  it("a stage pick is kept; a New-only pick cannot bring New back", () => {
    expect(toListLeadsFilters(scopeFiltersForPage({ ...base, stages: ["won"] }, true)).stages).toEqual(["won"]);
    expect(toListLeadsFilters(scopeFiltersForPage({ ...base, stages: ["new", "quote"] }, true)).stages).toEqual(["quote"]);
    expect(toListLeadsFilters(scopeFiltersForPage({ ...base, stages: ["new"] }, true)).stages)
      .toEqual(["demo", "lost", "quote", "trial", "won"]);
  });

  it("stageShownOnPage / pageStages", () => {
    expect(stageShownOnPage("won", false)).toBe(false);
    expect(stageShownOnPage("won", true)).toBe(true);
    expect(stageShownOnPage("lost", false)).toBe(true);
    expect(stageShownOnPage("new", true)).toBe(false);
    expect(stageShownOnPage("contact", true)).toBe(false);
    expect(pageStages(true).sort()).toEqual(["demo", "lost", "quote", "trial", "won"]);
  });

  it("folders: no Inbox / Talks on /deals, no Won on /leads", () => {
    expect(folderShownOnPage("inbox", true)).toBe(false);
    expect(folderShownOnPage("talks", true)).toBe(false);
    expect(folderShownOnPage("quoted", true)).toBe(true);
    expect(folderShownOnPage("won", false)).toBe(false);
    expect(folderShownOnPage("inbox", false)).toBe(true);
  });

  it('"Saari deals" count = the deal folders, not every lead in the workspace', () => {
    const counts = { workspace: { junk: 2, everything: 49, suspects: 0 },
      kpi: { open_count: 42, open_value: 0, open_value_project: 0, won: 2, lost: 5 }, folders };
    expect(everythingCountForPage(counts, true)).toBe(4 + 3 + 2 + 5);
  });
});

describe("the page wiring", () => {
  const src = readFileSync(join(process.cwd(), "src", "app", "(app)", "leads", "page.tsx"), "utf8");

  it("sends the scoped filters to BOTH readers", () => {
    expect(src).toMatch(/listFilters = React\.useMemo<LeadListFilters>\(\(\) => scopeFiltersForPage\(\{/);
    expect(src).toMatch(/\}, isDealsPage\), \[/);
    expect(src).toContain("useLeadCounts(listFilters)");
    expect(src).toContain("useLeadsInfinite(listFilters,");
    expect(src).toContain("everythingCount={everythingCountForPage(counts, isDealsPage)}");
  });

  it("the board reads only this page's columns", () => {
    expect(src).toMatch(/useLeadsBoard\([^)]*stages: boardStages/);
    expect(src).toContain("stages={DEAL_STAGES.filter((s) => stageShownOnPage(s.id, isDealsPage))}");
  });
});
