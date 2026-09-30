/**
 * Characterization tests for the Sales & Pipeline selectors (S35, 28 Sep 2026).
 *
 * These pin what the page's old inline memos DID — including the odd corners — so the
 * move out of (app)/leads/page.tsx cannot have changed which lead lands in which list or
 * in what order. A test here that reads like a bug report is deliberate: characterization
 * records behaviour, it does not judge it. Change the behaviour on purpose, then the test.
 */
import { describe, it, expect } from "vitest";
import type { Lead } from "@/lib/supabase/database.types";
import {
  boardCut, daysSince, inWorkspace, isOpenLead, junkCounts, listCut, nextSort, openTaskIndex,
  pipelineTotals, searchLeads, sortLeads, UNASSIGNED, wonThisMonth, type SearchInput,
} from "./list-selectors";

let seq = 0;
/** A clean, obviously-real lead; override what the case is about. */
function mk(over: Partial<Lead> = {}): Lead {
  seq += 1;
  return {
    id: `L-${seq}`,
    tenant_id: "t1",
    company: `Acme ${seq} Pvt Ltd`,
    contact_name: `Person ${seq}`,
    contact_email: `p${seq}@acme.in`,
    contact_phone: "+91 98765 43210",
    plan: null,
    seats: null,
    value: null,
    stage: "new",
    owner_id: null,
    source: null,
    notes: null,
    created_at: "2026-09-01T06:00:00.000Z",
    updated_at: "2026-09-01T06:00:00.000Z",
    follow_up_date: null,
    priority: "medium",
    is_junk: false,
    expected_close_date: null,
    stage_changed_at: null,
    requires_human_attention: false,
    enquiry_type: "subscription",
    ...over,
  } as Lead;
}

/* Local noon on 28 Sep 2026 — localDateISO() of this is "2026-09-28" in every timezone. */
const NOW = new Date(2026, 8, 28, 12, 0, 0);

const base: SearchInput = {
  search: "", stageFilter: [], priorityFilter: [], smartView: "everything",
  currentUser: { userId: "u-me" }, dupFlagged: new Set(), now: NOW,
};
const ids = (ls: readonly Lead[]) => ls.map((l) => l.id);

describe("isOpenLead", () => {
  it("is open unless won, lost or junk", () => {
    expect(isOpenLead(mk({ stage: "new" }))).toBe(true);
    expect(isOpenLead(mk({ stage: "quote" }))).toBe(true);
    expect(isOpenLead(mk({ stage: "won" }))).toBe(false);
    expect(isOpenLead(mk({ stage: "lost" }))).toBe(false);
    expect(isOpenLead(mk({ stage: "trial", is_junk: true }))).toBe(false);
  });
});

describe("inWorkspace — whose leads", () => {
  const mine = mk({ owner_id: "u-me" });
  const theirs = mk({ owner_id: "u-other" });
  const nobody = mk({ owner_id: null });
  it("null ids means no narrowing", () => {
    expect(ids(inWorkspace([mine, theirs, nobody], null))).toEqual(ids([mine, theirs, nobody]));
  });
  it("keeps owned-by-listed and UNOWNED rows, drops the rest", () => {
    expect(ids(inWorkspace([mine, theirs, nobody], ["u-me"]))).toEqual([mine.id, nobody.id]);
  });
});

describe("junkCounts", () => {
  it("counts confirmed junk, non-junk, and non-junk suspects", () => {
    const rows = [
      mk({ is_junk: true }),
      mk(),
      mk({ contact_phone: null, contact_email: null }),   // suspect: nothing to act on
      mk({ company: "test", is_junk: true }),             // junk AND would be a suspect — counted as junk only
    ];
    expect(junkCounts(rows)).toEqual({ junk: 2, everything: 2, suspects: 1 });
  });
});

describe("searchLeads — the page's old `searched` memo", () => {
  it("hides confirmed junk from every working view", () => {
    const j = mk({ is_junk: true });
    const ok = mk();
    for (const v of ["everything", "all", "new", "hot"] as const) {
      expect(ids(searchLeads([j, ok], { ...base, smartView: v }))).not.toContain(j.id);
    }
  });

  it("the Junk view shows confirmed junk PLUS heuristic suspects, and nothing clean", () => {
    const j = mk({ is_junk: true });
    const suspect = mk({ contact_phone: "", contact_email: "" });
    const ok = mk();
    expect(ids(searchLeads([j, suspect, ok], { ...base, smartView: "junk" }))).toEqual([j.id, suspect.id]);
  });

  it("text search is case-insensitive over company, contact, email, phone and plan — not notes", () => {
    const byCompany = mk({ company: "Zenith Traders" });
    const byName = mk({ contact_name: "ZENITH person" });
    const byEmail = mk({ contact_email: "a@zenith.io" });
    const byPhone = mk({ contact_phone: "zenith-line" });
    const byPlan = mk({ plan: "Zenith Plan" });
    const byNotes = mk({ notes: "zenith in notes only" });
    const rows = [byCompany, byName, byEmail, byPhone, byPlan, byNotes];
    expect(ids(searchLeads(rows, { ...base, search: "zEnItH" }))).toEqual(ids(rows.slice(0, 5)));
  });

  it("a whitespace-only search is no search", () => {
    const rows = [mk(), mk()];
    expect(searchLeads(rows, { ...base, search: "   " })).toHaveLength(2);
  });

  it("stage and priority filters are any-of; empty means no constraint", () => {
    const a = mk({ stage: "new", priority: "high" });
    const b = mk({ stage: "contact", priority: "low" });
    const c = mk({ stage: "quote", priority: "high" });
    expect(ids(searchLeads([a, b, c], { ...base, stageFilter: ["new", "quote"] }))).toEqual([a.id, c.id]);
    expect(ids(searchLeads([a, b, c], { ...base, priorityFilter: ["low"] }))).toEqual([b.id]);
    expect(ids(searchLeads([a, b, c], { ...base, stageFilter: ["new"], priorityFilter: ["low"] }))).toEqual([]);
  });

  it("owner filter (Kiska) is any-of, with UNASSIGNED for no owner; empty means no constraint", () => {
    const me = mk({ owner_id: "u-me" });
    const demo = mk({ owner_id: "u-demo" });
    const none = mk({ owner_id: null });
    expect(ids(searchLeads([me, demo, none], { ...base, ownerFilter: ["u-demo"] }))).toEqual([demo.id]);
    expect(ids(searchLeads([me, demo, none], { ...base, ownerFilter: [UNASSIGNED] }))).toEqual([none.id]);
    expect(ids(searchLeads([me, demo, none], { ...base, ownerFilter: ["u-me", UNASSIGNED] }))).toEqual([me.id, none.id]);
    expect(searchLeads([me, demo, none], { ...base, ownerFilter: [] })).toHaveLength(3);
  });

  it("mine: owner is the signed-in user; with no user, NOTHING matches", () => {
    const m = mk({ owner_id: "u-me" });
    const o = mk({ owner_id: "u-other" });
    expect(ids(searchLeads([m, o], { ...base, smartView: "mine" }))).toEqual([m.id]);
    expect(searchLeads([m, o], { ...base, smartView: "mine", currentUser: null })).toEqual([]);
  });

  it("waiting: the agent's handover flag, open deals only", () => {
    const w = mk({ requires_human_attention: true });
    const wonW = mk({ requires_human_attention: true, stage: "won" });
    const plain = mk();
    expect(ids(searchLeads([w, wonW, plain], { ...base, smartView: "waiting" }))).toEqual([w.id]);
  });

  it("today: created_at's LOCAL date equals the local date", () => {
    const t = mk({ created_at: "2026-09-28T10:00:00.000Z" });
    const y = mk({ created_at: "2026-09-27T10:00:00.000Z" });
    expect(ids(searchLeads([t, y], { ...base, smartView: "today" }))).toEqual([t.id]);
  });

  it("today: a lead that arrived just after local midnight is today (S40 — not its UTC date)", () => {
    /* In IST, 01:30 on the 28th is 20:00Z on the 27th. The old rule compared created_at's UTC
       date prefix, so this lead was "yesterday" until 05:30. Built from local time, so the
       test means the same thing in any time zone the suite runs in. */
    const early = mk({ created_at: new Date(2026, 8, 28, 1, 30).toISOString() });
    const now = new Date(2026, 8, 28, 9, 0);
    expect(ids(searchLeads([early], { ...base, now, smartView: "today" }))).toEqual([early.id]);
  });

  it("overdue: follow-up strictly before today, still open — due TODAY is not overdue", () => {
    const past = mk({ follow_up_date: "2026-09-27" });
    const today = mk({ follow_up_date: "2026-09-28" });
    const pastWon = mk({ follow_up_date: "2026-09-01", stage: "won" });
    const none = mk();
    expect(ids(searchLeads([past, today, pastWon, none], { ...base, smartView: "overdue" }))).toEqual([past.id]);
  });

  it("hot: priority high, or stage demo/trial/quote", () => {
    const hp = mk({ priority: "high" });
    const demo = mk({ stage: "demo" });
    const cold = mk({ stage: "contact" });
    expect(ids(searchLeads([hp, demo, cold], { ...base, smartView: "hot" }))).toEqual([hp.id, demo.id]);
  });

  it("new: stage new only", () => {
    const n = mk({ stage: "new" });
    const c = mk({ stage: "contact" });
    expect(ids(searchLeads([n, c], { ...base, smartView: "new" }))).toEqual([n.id]);
  });

  it("won-mtd: WON this month by the win date (stage_changed_at), not by when the lead arrived", () => {
    /* Deals audit, 30 Sep 2026: an August lead won on 3 Sep is September's win; a lead created
       in September but won in August (impossible-looking, but stage_changed_at says so) is not. */
    const arrivedAugWonSep = mk({ stage: "won", created_at: "2026-08-10T06:00:00.000Z", stage_changed_at: "2026-09-03T06:00:00.000Z" });
    const wonLastMonth = mk({ stage: "won", created_at: "2026-09-01T06:00:00.000Z", stage_changed_at: "2026-08-20T06:00:00.000Z" });
    const legacyNoWinDate = mk({ stage: "won", created_at: "2026-09-02T06:00:00.000Z" });
    const openThisMonth = mk({ stage: "quote", stage_changed_at: "2026-09-05T06:00:00.000Z" });
    expect(ids(searchLeads([arrivedAugWonSep, wonLastMonth, legacyNoWinDate, openThisMonth], { ...base, smartView: "won-mtd" })))
      .toEqual([arrivedAugWonSep.id, legacyNoWinDate.id]);
  });

  it("won-mtd uses the IST month: won at 00:30 IST on 1 Oct is October's, not September's", () => {
    const now = new Date("2026-10-01T00:00:00.000Z"); // 05:30 IST, 1 Oct
    expect(wonThisMonth({ stage: "won", created_at: null, stage_changed_at: "2026-09-30T19:00:00.000Z" } as never, now)).toBe(true);
    expect(wonThisMonth({ stage: "won", created_at: null, stage_changed_at: "2026-09-30T18:00:00.000Z" } as never, now)).toBe(false);
  });

  it("closing: open, dated, on or before month end; undated excluded", () => {
    const inMonth = mk({ expected_close_date: "2026-09-30" });
    const nextMonth = mk({ expected_close_date: "2026-10-01" });
    const overdueClose = mk({ expected_close_date: "2026-08-01" });
    const closedWon = mk({ expected_close_date: "2026-09-10", stage: "won" });
    const undated = mk();
    expect(ids(searchLeads([inMonth, nextMonth, overdueClose, closedWon, undated], { ...base, smartView: "closing" })))
      .toEqual([inMonth.id, overdueClose.id]);
  });

  it("stalled: open and past the 7-day stage SLA; unknown age is never stalled", () => {
    const stale = mk({ stage: "quote", stage_changed_at: "2026-09-10T00:00:00.000Z" });
    const fresh = mk({ stage: "quote", stage_changed_at: "2026-09-27T00:00:00.000Z" });
    const unknown = mk({ stage: "quote", stage_changed_at: null });
    const wonOld = mk({ stage: "won", stage_changed_at: "2026-01-01T00:00:00.000Z" });
    expect(ids(searchLeads([stale, fresh, unknown, wonOld], { ...base, smartView: "stalled" }))).toEqual([stale.id]);
  });

  it("duplicates: exactly the flagged ids", () => {
    const a = mk();
    const b = mk();
    expect(ids(searchLeads([a, b], { ...base, smartView: "duplicates", dupFlagged: new Set([b.id]) }))).toEqual([b.id]);
  });

  it("all and everything apply no view cut (won and lost stay in)", () => {
    const rows = [mk({ stage: "won" }), mk({ stage: "lost" }), mk()];
    expect(searchLeads(rows, { ...base, smartView: "all" })).toHaveLength(3);
    expect(searchLeads(rows, { ...base, smartView: "everything" })).toHaveLength(3);
  });

  it("does not mutate its input", () => {
    const rows = [mk({ is_junk: true }), mk()];
    const copy = [...rows];
    searchLeads(rows, base);
    expect(rows).toEqual(copy);
  });
});

describe("listCut — what the LIST shows", () => {
  const open = mk({ stage: "contact" });
  const won = mk({ stage: "won" });
  const lost = mk({ stage: "lost" });
  const quoted = mk({ stage: "quote" });
  const searched = [open, won, lost, quoted];
  const TODAY = "2026-09-28";

  it("Junk view: the searched set as-is", () => {
    expect(ids(listCut(searched, "all", "junk", TODAY))).toEqual(ids(searched));
  });
  it("no folder + All leads: everything searched, won and lost included", () => {
    expect(ids(listCut(searched, "all", "everything", TODAY))).toEqual(ids(searched));
  });
  it("no folder + any other view: open leads only", () => {
    expect(ids(listCut(searched, "all", "hot", TODAY))).toEqual([open.id, quoted.id]);
  });
  it("a folder: exactly that folder's leads", () => {
    expect(ids(listCut(searched, "quoted", "everything", TODAY))).toEqual([quoted.id]);
    expect(ids(listCut(searched, "won", "everything", TODAY))).toEqual([won.id]);
  });
});

describe("boardCut — the board holds its own Won column", () => {
  const open = mk({ stage: "new" });
  const won = mk({ stage: "won" });
  const lost = mk({ stage: "lost" });
  const junk = mk({ stage: "quote", is_junk: true });
  it("no folder: open + won, never lost or junk", () => {
    expect(ids(boardCut([open, won, lost, junk], [], "all", "everything"))).toEqual([open.id, won.id]);
  });
  it("a folder, or the Junk view: whatever the list shows", () => {
    expect(ids(boardCut([open, won], [won], "won", "everything"))).toEqual([won.id]);
    expect(ids(boardCut([open, won], [open], "all", "junk"))).toEqual([open.id]);
  });
});

describe("pipelineTotals — every non-junk lead is a deal", () => {
  it("sums value over open non-junk deals; junk is the only exclusion from the universe", () => {
    const rows = [
      mk({ stage: "new", value: 1000 }),
      mk({ stage: "quote", value: 2500 }),
      mk({ stage: "won", value: 9000 }),
      mk({ stage: "lost", value: 7000 }),
      mk({ stage: "quote", value: 50000, is_junk: true }),
      mk({ stage: "contact", value: null }),
    ];
    const t = pipelineTotals(rows);
    expect(t.dealUniverse).toHaveLength(5);
    expect(t.openDeals).toHaveLength(3);
    expect(t.totalValue).toBe(3500);
  });
});

describe("sortLeads — the list view's column sort", () => {
  const ctx = { firstReplies: new Map<string, string>(), now: NOW, ownerName: () => null };

  it("value / seats sort numerically, null as 0", () => {
    const a = mk({ value: 500 });
    const b = mk({ value: null });
    const c = mk({ value: 9000 });
    expect(ids(sortLeads([a, b, c], "value", "desc", ctx))).toEqual([c.id, a.id, b.id]);
    expect(ids(sortLeads([a, b, c], "value", "asc", ctx))).toEqual([b.id, a.id, c.id]);
  });

  it("text columns put BLANKS LAST in both directions", () => {
    const a = mk({ contact_name: "Bina" });
    const blank = mk({ contact_name: "  " });
    const c = mk({ contact_name: "Amit" });
    expect(ids(sortLeads([a, blank, c], "contact", "asc", ctx))).toEqual([c.id, a.id, blank.id]);
    expect(ids(sortLeads([a, blank, c], "contact", "desc", ctx))).toEqual([a.id, c.id, blank.id]);
  });

  it("created sorts by instant; desc puts newest first", () => {
    const old = mk({ created_at: "2026-01-01T00:00:00Z" });
    const mid = mk({ created_at: "2026-05-01T00:00:00Z" });
    const neu = mk({ created_at: "2026-09-01T00:00:00Z" });
    expect(ids(sortLeads([mid, old, neu], "created", "desc", ctx))).toEqual([neu.id, mid.id, old.id]);
  });

  it("wait (default, desc): waiting leads above answered ones, longest wait first", () => {
    const answeredSlow = mk({ created_at: "2026-09-28T00:00:00Z" });
    const waitingShort = mk({ created_at: "2026-09-28T06:00:00Z" });
    const waitingLong = mk({ created_at: "2026-09-20T06:00:00Z" });
    const unknown = mk({ created_at: "not a date" });
    const firstReplies = new Map([[answeredSlow.id, "2026-09-28T05:00:00Z"]]);
    const out = sortLeads([answeredSlow, unknown, waitingShort, waitingLong], "wait", "desc", { ...ctx, firstReplies });
    expect(ids(out)).toEqual([waitingLong.id, waitingShort.id, answeredSlow.id, unknown.id]);
  });

  it("owner sorts by NAME, unowned last", () => {
    const zed = mk({ owner_id: "u1" });
    const amy = mk({ owner_id: "u2" });
    const none = mk({ owner_id: null });
    const names: Record<string, string> = { u1: "Zed", u2: "Amy" };
    const out = sortLeads([zed, none, amy], "owner", "asc", { ...ctx, ownerName: (id) => names[id] });
    expect(ids(out)).toEqual([amy.id, zed.id, none.id]);
  });

  it("stage sorts by the stage KEY alphabetically, not funnel order", () => {
    const rows = [mk({ stage: "won" }), mk({ stage: "contact" }), mk({ stage: "quote" })];
    expect(sortLeads(rows, "stage", "asc", ctx).map((l) => l.stage)).toEqual(["contact", "quote", "won"]);
  });

  it("does not mutate its input", () => {
    const rows = [mk({ value: 2 }), mk({ value: 1 })];
    const before = ids(rows);
    sortLeads(rows, "value", "asc", ctx);
    expect(ids(rows)).toEqual(before);
  });
});

describe("nextSort — clicking a header", () => {
  it("same column flips; a new column starts desc, except company which starts asc", () => {
    expect(nextSort({ sortBy: "value", sortDir: "desc" }, "value")).toEqual({ sortBy: "value", sortDir: "asc" });
    expect(nextSort({ sortBy: "value", sortDir: "asc" }, "seats")).toEqual({ sortBy: "seats", sortDir: "desc" });
    expect(nextSort({ sortBy: "value", sortDir: "desc" }, "company")).toEqual({ sortBy: "company", sortDir: "asc" });
  });
});

describe("openTaskIndex — the task chip on a row", () => {
  const nowMs = new Date("2026-09-28T12:00:00Z").getTime();
  it("keeps the EARLIEST open task per lead, counts all open ones, ignores done", () => {
    const m = openTaskIndex([
      { lead_id: "L1", status: "pending", due_at: "2026-09-30T00:00:00Z" },
      { lead_id: "L1", status: "snoozed", due_at: "2026-09-20T00:00:00Z" },
      { lead_id: "L1", status: "done", due_at: "2026-09-01T00:00:00Z" },
      { lead_id: null, status: "pending", due_at: "2026-09-01T00:00:00Z" },
      { lead_id: "L2", status: "pending", due_at: "2026-10-05T00:00:00Z" },
    ], nowMs);
    expect(m.get("L1")).toEqual({ due: "2026-09-20T00:00:00Z", overdue: true, count: 2 });
    expect(m.get("L2")).toEqual({ due: "2026-10-05T00:00:00Z", overdue: false, count: 1 });
    expect(m.size).toBe(2);
  });
});

describe("daysSince", () => {
  it("floors whole days", () => {
    const now = new Date("2026-09-28T12:00:00Z").getTime();
    expect(daysSince("2026-09-27T12:00:01Z", now)).toBe(0);
    expect(daysSince("2026-09-26T12:00:00Z", now)).toBe(2);
    expect(daysSince("2026-09-29", now)).toBeLessThan(0);
  });
});
