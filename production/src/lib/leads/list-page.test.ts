/**
 * list_leads() filter parity (S37). `matchesListLeadsFilters` is the migration's WHERE clause
 * written in TypeScript; supabase/tests/list_rpcs.test.sql holds the SQL to the same cases.
 * Here the TS mirror is held to the PAGE's own rules (list-selectors.ts), over every
 * combination of the server-expressible filters — so "the server returns what the page
 * would have shown" is checked, not assumed.
 */
import { describe, it, expect } from "vitest";
import type { Lead } from "@/lib/supabase/database.types";
import { inWorkspace, isOpenLead, searchLeads } from "./list-selectors";
import { matchesListLeadsFilters, toListLeadsFilters, type LeadListFilters } from "./list-page";

let n = 0;
const mk = (over: Partial<Lead>): Lead => {
  n += 1;
  return {
    id: `L${n}`, company: `Co ${n}`, contact_name: null, contact_email: null, contact_phone: "+91 90000 0000" + (n % 10),
    plan: null, stage: "new", priority: "medium", is_junk: false, owner_id: null,
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
    ...over,
  } as Lead;
};

const ROWS: Lead[] = [
  mk({ company: "Alpha Traders", contact_name: "Asha", stage: "new", priority: "high", owner_id: "u1" }),
  mk({ company: "Beta Works", contact_email: "bina_t@beta.in", stage: "contact", owner_id: "u2" }),
  mk({ company: "Gamma 100% Pure", stage: "quote", priority: "low" }),
  mk({ company: "Delta", plan: "ZOHO Mail Lite", stage: "demo", owner_id: "u2" }),
  mk({ company: "Epsilon", stage: "won" }),
  mk({ company: "Zeta", stage: "lost", priority: "high" }),
  mk({ company: "test", stage: "new", is_junk: true, contact_phone: null }),
  mk({ company: "Theta", contact_name: "Tara", stage: "trial", priority: "low" }),
];

const ids = (ls: readonly { id: string }[]) => ls.map((l) => l.id);
const NOW = new Date(2026, 8, 28, 12);

describe("toListLeadsFilters — one JSON per meaning", () => {
  it("drops every key that means 'no constraint'", () => {
    expect(toListLeadsFilters({ search: "  ", stages: [], priorities: [], junk: "exclude", open_only: false })).toEqual({});
  });
  it("keeps search AS TYPED when it has content, and sorts the any-of lists", () => {
    expect(toListLeadsFilters({ search: " Acme ", stages: ["quote", "new"], priorities: ["low", "high"] }))
      .toEqual({ search: " Acme ", stages: ["new", "quote"], priorities: ["high", "low"] });
  });
  it("an EMPTY owner_ids is a real filter (unowned only), not an omission", () => {
    expect(toListLeadsFilters({ owner_ids: [] })).toEqual({ owner_ids: [] });
  });
  it("equivalent states give identical JSON (so identical query keys)", () => {
    expect(JSON.stringify(toListLeadsFilters({ stages: ["won", "new"] })))
      .toBe(JSON.stringify(toListLeadsFilters({ stages: ["new", "won"], search: "" })));
  });
});

describe("parity with the page's searchLeads(), everything view", () => {
  const searches = ["", "alpha", "ALPHA", "a_t", "100%", "%", "zoho mail", "zeta ", "a t", "0000", "nomatch"];
  const stageSets: Lead["stage"][][] = [[], ["new"], ["quote", "demo"], ["won", "lost"]];
  const prioSets: Array<Array<"low" | "medium" | "high">> = [[], ["high"], ["low", "medium"]];

  for (const search of searches) for (const stageFilter of stageSets) for (const priorityFilter of prioSets) {
    it(`search=${JSON.stringify(search)} stages=${stageFilter.join("|") || "-"} prio=${priorityFilter.join("|") || "-"}`, () => {
      const page = searchLeads(ROWS, {
        search, stageFilter, priorityFilter, smartView: "everything",
        currentUser: null, dupFlagged: new Set(), now: NOW,
      });
      const f: LeadListFilters = toListLeadsFilters({ search, stages: stageFilter, priorities: priorityFilter });
      const server = ROWS.filter((l) => matchesListLeadsFilters(l, f));
      expect(ids(server)).toEqual(ids(page));
    });
  }
});

describe("parity with the page's other cuts", () => {
  it("open_only ↔ isOpenLead", () => {
    expect(ids(ROWS.filter((l) => matchesListLeadsFilters(l, { junk: "any", open_only: true }))))
      .toEqual(ids(ROWS.filter(isOpenLead)));
  });
  it("owner_ids ↔ inWorkspace (listed owners OR unowned)", () => {
    for (const team of [["u1"], ["u2"], ["u1", "u2"], []]) {
      expect(ids(ROWS.filter((l) => matchesListLeadsFilters(l, { junk: "any", owner_ids: team }))))
        .toEqual(ids(inWorkspace(ROWS, team)));
    }
  });
  it("owner_id ↔ the Mine view", () => {
    const mine = searchLeads(ROWS, {
      search: "", stageFilter: [], priorityFilter: [], smartView: "mine",
      currentUser: { userId: "u2" }, dupFlagged: new Set(), now: NOW,
    });
    expect(ids(ROWS.filter((l) => matchesListLeadsFilters(l, { owner_id: "u2" })))).toEqual(ids(mine));
  });
  it("junk only is CONFIRMED junk — the page's Junk view also adds heuristic suspects, which the server does not", () => {
    const suspectNotJunk = mk({ company: "x", contact_phone: null, contact_email: null });
    const rows = [...ROWS, suspectNotJunk];
    const pageJunkView = searchLeads(rows, {
      search: "", stageFilter: [], priorityFilter: [], smartView: "junk",
      currentUser: null, dupFlagged: new Set(), now: NOW,
    });
    const server = rows.filter((l) => matchesListLeadsFilters(l, { junk: "only" }));
    expect(ids(server)).toEqual(ids(rows.filter((l) => l.is_junk)));
    expect(ids(pageJunkView)).toContain(suspectNotJunk.id);
    expect(ids(server)).not.toContain(suspectNotJunk.id);
  });
});
