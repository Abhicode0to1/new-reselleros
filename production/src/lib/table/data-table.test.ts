import { describe, it, expect } from "vitest";
import {
  sortRows, nextSort, toggleAllIds, toggleId, pagedCount,
  loadViews, saveView, deleteView, isViewActive, viewsKey, MAX_VIEWS,
  type ViewStorage,
} from "./data-table";

function memStorage(): ViewStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

const inv = [
  { id: "INV-10", amount: 500, due: "2026-10-05" },
  { id: "INV-2", amount: 1500, due: null },
  { id: "INV-9", amount: 500, due: "2026-09-30" },
];

describe("sortRows", () => {
  it("numbers ascending and descending, ties keep the original order", () => {
    expect(sortRows(inv, (r) => r.amount, "asc").map((r) => r.id)).toEqual(["INV-10", "INV-9", "INV-2"]);
    expect(sortRows(inv, (r) => r.amount, "desc").map((r) => r.id)).toEqual(["INV-2", "INV-10", "INV-9"]);
  });

  it("text sorts numerically inside (INV-2 before INV-10)", () => {
    expect(sortRows(inv, (r) => r.id, "asc").map((r) => r.id)).toEqual(["INV-2", "INV-9", "INV-10"]);
  });

  it("empty values go last in both directions", () => {
    expect(sortRows(inv, (r) => r.due, "asc").map((r) => r.id)).toEqual(["INV-9", "INV-10", "INV-2"]);
    expect(sortRows(inv, (r) => r.due, "desc").map((r) => r.id)).toEqual(["INV-10", "INV-9", "INV-2"]);
  });

  it("no sort column = the page's own order, as a copy", () => {
    const out = sortRows(inv, undefined, "asc");
    expect(out).toEqual(inv);
    expect(out).not.toBe(inv);
  });
});

describe("nextSort", () => {
  it("cycles asc → desc → off, and a new column starts at asc", () => {
    const a = nextSort(null, "amount");
    expect(a).toEqual({ id: "amount", dir: "asc" });
    const d = nextSort(a, "amount");
    expect(d).toEqual({ id: "amount", dir: "desc" });
    expect(nextSort(d, "amount")).toBeNull();
    expect(nextSort(d, "due")).toEqual({ id: "due", dir: "asc" });
  });
});

describe("selection", () => {
  it("select-all picks every visible row, a second click clears", () => {
    const all = toggleAllIds(new Set(), ["a", "b"]);
    expect([...all]).toEqual(["a", "b"]);
    expect(toggleAllIds(all, ["a", "b"]).size).toBe(0);
  });

  it("select-all with some picked selects the rest", () => {
    expect([...toggleAllIds(new Set(["a"]), ["a", "b"])].sort()).toEqual(["a", "b"]);
  });

  it("toggleId adds and removes without touching the input", () => {
    const s = new Set(["a"]);
    expect([...toggleId(s, "b")].sort()).toEqual(["a", "b"]);
    expect(toggleId(s, "a").size).toBe(0);
    expect(s.size).toBe(1);
  });
});

describe("saved views", () => {
  it("saves, reloads, replaces by name (any case), newest first", () => {
    const st = memStorage();
    saveView(st, "invoices", { name: "Overdue", state: { tab: "overdue" }, sort: null });
    saveView(st, "invoices", { name: "This month", state: { dateRange: "this_month" }, sort: { id: "amount", dir: "desc" } });
    const list = saveView(st, "invoices", { name: "overdue ", state: { tab: "overdue", search: "acme" }, sort: null });
    expect(list.map((v) => v.name)).toEqual(["overdue", "This month"]);
    expect(loadViews(st, "invoices")).toEqual(list);
    expect(st.data.has(viewsKey("invoices"))).toBe(true);
  });

  it("ignores a blank name and caps the list", () => {
    const st = memStorage();
    expect(saveView(st, "k", { name: "  ", state: {}, sort: null })).toEqual([]);
    for (let i = 0; i < MAX_VIEWS + 3; i++) saveView(st, "k", { name: `v${i}`, state: { i }, sort: null });
    expect(loadViews(st, "k")).toHaveLength(MAX_VIEWS);
  });

  it("deletes by name", () => {
    const st = memStorage();
    saveView(st, "k", { name: "A", state: {}, sort: null });
    saveView(st, "k", { name: "B", state: {}, sort: null });
    expect(deleteView(st, "k", "A").map((v) => v.name)).toEqual(["B"]);
  });

  it("survives broken or missing storage (private window)", () => {
    const st = memStorage();
    st.data.set(viewsKey("k"), "{not json");
    expect(loadViews(st, "k")).toEqual([]);
    expect(loadViews(null, "k")).toEqual([]);
    const throwing: ViewStorage = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    expect(saveView(throwing, "k", { name: "A", state: {}, sort: null })).toEqual([]);
  });

  it("drops malformed entries and a bad sort", () => {
    const st = memStorage();
    st.data.set(viewsKey("k"), JSON.stringify([{ name: "ok", state: { a: 1 }, sort: { id: "x", dir: "up" } }, { name: 5 }, null]));
    expect(loadViews(st, "k")).toEqual([{ name: "ok", state: { a: 1 }, sort: null }]);
  });

  it("isViewActive compares state regardless of key order, plus sort", () => {
    const v = { name: "x", state: { tab: "paid", view: "all" }, sort: { id: "amount", dir: "asc" as const } };
    expect(isViewActive(v, { view: "all", tab: "paid" }, { id: "amount", dir: "asc" })).toBe(true);
    expect(isViewActive(v, { view: "all", tab: "paid" }, null)).toBe(false);
    expect(isViewActive(v, { view: "all", tab: "overdue" }, { id: "amount", dir: "asc" })).toBe(false);
  });
});

describe("pagedCount (R-024)", () => {
  it("shows the page size, never more than there are", () => {
    expect(pagedCount(312, 50)).toBe(50);
    expect(pagedCount(12, 50)).toBe(12);
    expect(pagedCount(0, 50)).toBe(0);
  });
  it("a deep-linked row beyond the page is brought on screen", () => {
    expect(pagedCount(312, 50, 120)).toBe(121);
    expect(pagedCount(312, 50, 10)).toBe(50);   // already visible: unchanged
    expect(pagedCount(312, 150, 120)).toBe(150); // never shrinks what was loaded
  });
});
