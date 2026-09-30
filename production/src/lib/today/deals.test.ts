import { describe, it, expect } from "vitest";
import { dealTodayItems, latestFollowUps, DEAL_KIND_CAP } from "./deals";
import { kindMeta, rankTodayItems } from "./inbox";
import type { DealRow } from "@/lib/deals/pipeline-summary";

/* 30 Sep 2026, 10:00 IST. */
const NOW = new Date("2026-09-30T04:30:00Z");

let n = 0;
const deal = (p: Partial<DealRow>): DealRow => ({
  id: `d${++n}`, company: `Co ${n}`, stage: "demo", value: 0, expected_close_date: null,
  stage_changed_at: null, created_at: "2026-09-01T05:00:00Z", owner_id: null, lost_at: null, ...p,
});

describe("dealTodayItems", () => {
  it("close date passed → deal_overdue, linked to the deal", () => {
    const d = deal({ company: "Acme", value: 120_000, expected_close_date: "2026-09-27" });
    const [i] = dealTodayItems([d], null, NOW);
    expect(i.kind).toBe("deal_overdue");
    expect(i.href).toBe(`/deals?lead=${d.id}`);
    expect(i.title).toMatch(/^Acme — close date nikal gayi \(3d\)/);
    expect(i.due_at).toBe("2026-09-26T18:30:00.000Z");
    expect(i.priority).toBe(65);
  });

  it("closing today or within the next 7 IST days → deal_closing; day 8 is out", () => {
    const items = dealTodayItems([
      deal({ id: "t0", expected_close_date: "2026-09-30" }),
      deal({ id: "t6", expected_close_date: "2026-10-06" }),
      deal({ id: "t7", expected_close_date: "2026-10-07" }),
    ], null, NOW);
    expect(items.map((i) => [i.kind, i.id])).toEqual([["deal_closing", "t0"], ["deal_closing", "t6"]]);
  });

  it("quote ≥7 days old with no follow-up → deal_quote_stale; 6 days is not", () => {
    const items = dealTodayItems([
      deal({ id: "q7", stage: "quote", stage_changed_at: "2026-09-23T05:00:00Z" }),
      deal({ id: "q6", stage: "quote", stage_changed_at: "2026-09-24T05:00:00Z" }),
    ], null, NOW);
    expect(items.map((i) => [i.kind, i.id])).toEqual([["deal_quote_stale", "q7"]]);
    expect(items[0].title).toContain("quote bheje 7 din, koi follow-up nahi");
  });

  it("a follow-up after the quote clears it; one from before does not", () => {
    const q = deal({ id: "q", stage: "quote", stage_changed_at: "2026-09-10T05:00:00Z" });
    expect(dealTodayItems([q], new Map([["q", "2026-09-12T05:00:00Z"]]), NOW)).toEqual([]);
    expect(dealTodayItems([q], new Map([["q", "2026-09-09T05:00:00Z"]]), NOW)).toHaveLength(1);
  });

  it("one row per deal — overdue wins over a stale quote", () => {
    const items = dealTodayItems([
      deal({ stage: "quote", stage_changed_at: "2026-09-01T05:00:00Z", expected_close_date: "2026-09-20" }),
    ], null, NOW);
    expect(items.map((i) => i.kind)).toEqual(["deal_overdue"]);
  });

  it("won, lost and non-deal stages never show", () => {
    expect(dealTodayItems([
      deal({ stage: "won", expected_close_date: "2026-09-01" }),
      deal({ stage: "lost", expected_close_date: "2026-09-01" }),
      deal({ stage: "new", expected_close_date: "2026-09-01" }),
    ], null, NOW)).toEqual([]);
  });

  it("caps each kind at 50, and every kind has a label", () => {
    const many = Array.from({ length: 60 }, () => deal({ expected_close_date: "2026-09-01" }));
    const items = dealTodayItems(many, null, NOW);
    expect(items).toHaveLength(DEAL_KIND_CAP);
    for (const k of ["deal_overdue", "deal_quote_stale", "deal_closing"]) expect(kindMeta(k).label).not.toBe(k);
  });

  it("ranks alongside inbox items on the shared scale", () => {
    const deals = dealTodayItems([deal({ id: "x", expected_close_date: "2026-09-29" })], null, NOW);
    const ranked = rankTodayItems([
      { kind: "task", id: "t", title: "t", due_at: null, priority: 70, href: "/tasks" },
      ...deals,
      { kind: "automation", id: "a", title: "a", due_at: null, priority: 45, href: "/automation" },
    ]);
    expect(ranked.map((i) => i.kind)).toEqual(["task", "deal_overdue", "automation"]);
  });
});

describe("latestFollowUps", () => {
  it("keeps the latest per lead and ignores 'stage' rows", () => {
    const m = latestFollowUps([
      { lead_id: "a", created_at: "2026-09-10T05:00:00Z", kind: "call" },
      { lead_id: "a", created_at: "2026-09-12T05:00:00Z", kind: "note" },
      { lead_id: "a", created_at: "2026-09-20T05:00:00Z", kind: "stage" },
      { lead_id: "b", created_at: "2026-09-20T05:00:00Z", kind: "stage" },
    ]);
    expect(m.get("a")).toBe("2026-09-12T05:00:00Z");
    expect(m.has("b")).toBe(false);
  });
});
