import { describe, it, expect } from "vitest";
import {
  tabsReducer, tabIdFor, forceClose, draftTabs,
  emptyTabs, MAX_TABS,
  type TabsState, type WorkspaceTab,
} from "./tabs";

/** Build a state directly, so each test starts exactly where it means to. */
const state = (tabs: Partial<WorkspaceTab>[], activeId: string | null = null): TabsState => ({
  tabs: tabs.map((t, i) => ({
    id: t.id ?? `/t${i}`,
    url: t.url ?? t.id ?? `/t${i}`,
    title: t.title ?? `Tab ${i}`,
    isDraft: t.isDraft ?? false,
    formState: t.formState,
    lastAccessedAt: t.lastAccessedAt ?? i,
  })),
  activeId,
});

const open = (s: TabsState, url: string, at = 100) =>
  tabsReducer(s, { type: "open", url, title: url, at });

describe("tabIdFor — one tab per page, not one per click", () => {
  it("treats the same path as the same tab", () => {
    expect(tabIdFor("/customers/123")).toBe(tabIdFor("/customers/123/"));
  });

  it("keeps the query string, because it is different work", () => {
    // /quotes/new?customer=abc and /quotes/new are two different half-finished
    // quotes, not one.
    expect(tabIdFor("/quotes/new?customer=abc")).not.toBe(tabIdFor("/quotes/new"));
  });

  it("ignores the hash, which is a position on the SAME page", () => {
    // Otherwise every anchor click opens a duplicate tab.
    expect(tabIdFor("/help#billing")).toBe(tabIdFor("/help#taxes"));
  });

  it("survives empty input", () => {
    expect(tabIdFor("")).toBe("/");
  });
});

describe("open", () => {
  it("adds a tab and makes it active", () => {
    const r = open(emptyTabs, "/customers");
    expect(r.state.tabs).toHaveLength(1);
    expect(r.state.activeId).toBe("/customers");
  });

  it("FOCUSES an already-open page instead of duplicating it", () => {
    // Two tabs on one page would fight over the same draft.
    const s = state([{ id: "/quotes/new", isDraft: true }], "/other");
    const r = open(s, "/quotes/new", 500);
    expect(r.state.tabs).toHaveLength(1);
    expect(r.state.activeId).toBe("/quotes/new");
    expect(r.state.tabs[0].isDraft).toBe(true);      // the draft is untouched
    expect(r.state.tabs[0].lastAccessedAt).toBe(500);
  });
});

describe(`the ${MAX_TABS}-tab limit`, () => {
  const full = (over: Partial<WorkspaceTab>[] = []) =>
    state(Array.from({ length: MAX_TABS }, (_, i) => ({
      id: `/t${i}`, lastAccessedAt: i, ...(over[i] ?? {}),
    })), "/t0");

  it("evicts the least recently used tab to make room", () => {
    const r = open(full(), "/new", 999);
    expect(r.state.tabs).toHaveLength(MAX_TABS);
    expect(r.state.tabs.map((t) => t.id)).not.toContain("/t0");   // oldest
    expect(r.state.activeId).toBe("/new");
  });

  it("NEVER evicts a draft, even when it is the oldest", () => {
    // The whole point of the feature. Evicting by age alone would throw away the
    // quote someone was half-way through typing.
    const s = full([{ id: "/t0", lastAccessedAt: 0, isDraft: true }]);
    const r = open(s, "/new", 999);
    expect(r.state.tabs.map((t) => t.id)).toContain("/t0");
    expect(r.state.tabs.map((t) => t.id)).not.toContain("/t1");   // next oldest
  });

  it("refuses and ASKS when every tab holds unsaved work", () => {
    const s = full(Array.from({ length: MAX_TABS }, (_, i) => ({ id: `/t${i}`, isDraft: true })));
    const r = open(s, "/new", 999);
    expect(r.state).toEqual(s);                       // nothing changed
    expect(r.needsConfirm?.kind).toBe("evict_all_drafts");
    expect(r.needsConfirm?.message).toMatch(/unsaved changes/i);
  });

  it("picks the OLDEST non-draft, not simply the oldest", () => {
    const s = full([
      { id: "/t0", lastAccessedAt: 0, isDraft: true },
      { id: "/t1", lastAccessedAt: 1, isDraft: true },
      { id: "/t2", lastAccessedAt: 2 },
    ]);
    const r = open(s, "/new", 999);
    expect(r.state.tabs.map((t) => t.id)).not.toContain("/t2");
    expect(r.state.tabs.map((t) => t.id)).toEqual(expect.arrayContaining(["/t0", "/t1"]));
  });

  it("never exceeds the limit", () => {
    let s = emptyTabs;
    for (let i = 0; i < MAX_TABS * 3; i++) s = open(s, `/page${i}`, i).state;
    expect(s.tabs.length).toBeLessThanOrEqual(MAX_TABS);
  });
});

describe("close", () => {
  it("closes a clean tab", () => {
    const s = state([{ id: "/a" }, { id: "/b" }], "/a");
    const r = tabsReducer(s, { type: "close", id: "/a" });
    expect(r.state.tabs.map((t) => t.id)).toEqual(["/b"]);
  });

  it("REFUSES to close a draft and asks instead", () => {
    const s = state([{ id: "/a", isDraft: true }], "/a");
    const r = tabsReducer(s, { type: "close", id: "/a" });
    expect(r.state.tabs).toHaveLength(1);            // still there
    expect(r.needsConfirm?.kind).toBe("close_draft");
    expect(r.needsConfirm?.message).toBe("You have unsaved changes. Close tab anyway?");
  });

  it("closes it once the user has confirmed", () => {
    const s = state([{ id: "/a", isDraft: true }, { id: "/b" }], "/a");
    const after = forceClose(s, "/a");
    expect(after.tabs.map((t) => t.id)).toEqual(["/b"]);
    expect(after.activeId).toBe("/b");
  });

  it("activates the tab to the RIGHT, the way editors do", () => {
    // Jumping to the most-recent tab instead makes the cursor appear to teleport
    // across the strip.
    const s = state([{ id: "/a" }, { id: "/b" }, { id: "/c" }], "/b");
    const r = tabsReducer(s, { type: "close", id: "/b" });
    expect(r.state.activeId).toBe("/c");
  });

  it("falls back to the left when the last tab is closed", () => {
    const s = state([{ id: "/a" }, { id: "/b" }], "/b");
    expect(tabsReducer(s, { type: "close", id: "/b" }).state.activeId).toBe("/a");
  });

  it("leaves the active tab alone when a background tab closes", () => {
    const s = state([{ id: "/a" }, { id: "/b" }], "/a");
    expect(tabsReducer(s, { type: "close", id: "/b" }).state.activeId).toBe("/a");
  });

  it("clears activeId when the last tab goes", () => {
    const s = state([{ id: "/a" }], "/a");
    expect(tabsReducer(s, { type: "close", id: "/a" }).state.activeId).toBeNull();
  });

  it("ignores a close for a tab that is not open", () => {
    const s = state([{ id: "/a" }], "/a");
    expect(tabsReducer(s, { type: "close", id: "/nope" }).state).toEqual(s);
  });
});

describe("closeOthers keeps drafts — tidying must not destroy", () => {
  it("keeps the target and every draft", () => {
    const s = state([
      { id: "/a" }, { id: "/b", isDraft: true }, { id: "/c" }, { id: "/d", isDraft: true },
    ], "/a");
    const r = tabsReducer(s, { type: "closeOthers", id: "/a" });
    expect(r.state.tabs.map((t) => t.id).sort()).toEqual(["/a", "/b", "/d"]);
  });

  it("moves focus to the target when the active tab was closed", () => {
    const s = state([{ id: "/a" }, { id: "/b" }], "/b");
    expect(tabsReducer(s, { type: "closeOthers", id: "/a" }).state.activeId).toBe("/a");
  });
});

describe("draft state", () => {
  it("stores what was typed", () => {
    const s = state([{ id: "/q" }], "/q");
    const r = tabsReducer(s, { type: "setDraft", id: "/q", isDraft: true, formState: { seats: 25 } });
    expect(r.state.tabs[0].isDraft).toBe(true);
    expect(r.state.tabs[0].formState).toEqual({ seats: 25 });
  });

  it("CLEARS the stored values when the form is saved", () => {
    // Lingering values would restore stale input the next time the tab is opened,
    // which looks like the app resurrecting data the user already replaced.
    const s = state([{ id: "/q", isDraft: true, formState: { seats: 25 } }], "/q");
    const r = tabsReducer(s, { type: "setDraft", id: "/q", isDraft: false });
    expect(r.state.tabs[0].isDraft).toBe(false);
    expect(r.state.tabs[0].formState).toBeUndefined();
  });

  it("keeps existing values when the flag is re-set without new ones", () => {
    const s = state([{ id: "/q", isDraft: true, formState: { seats: 25 } }], "/q");
    const r = tabsReducer(s, { type: "setDraft", id: "/q", isDraft: true });
    expect(r.state.tabs[0].formState).toEqual({ seats: 25 });
  });

  it("lists the tabs that would lose work", () => {
    const s = state([{ id: "/a" }, { id: "/b", isDraft: true }, { id: "/c", isDraft: true }]);
    expect(draftTabs(s).map((t) => t.id)).toEqual(["/b", "/c"]);
  });
});

describe("cycle", () => {
  const s = state([{ id: "/a" }, { id: "/b" }, { id: "/c" }], "/b");

  it("moves forward and back", () => {
    expect(tabsReducer(s, { type: "cycle", direction: 1, at: 9 }).state.activeId).toBe("/c");
    expect(tabsReducer(s, { type: "cycle", direction: -1, at: 9 }).state.activeId).toBe("/a");
  });

  it("wraps at both ends, like every tab strip people already know", () => {
    const last = state([{ id: "/a" }, { id: "/b" }], "/b");
    expect(tabsReducer(last, { type: "cycle", direction: 1, at: 9 }).state.activeId).toBe("/a");
    const first = state([{ id: "/a" }, { id: "/b" }], "/a");
    expect(tabsReducer(first, { type: "cycle", direction: -1, at: 9 }).state.activeId).toBe("/b");
  });

  it("does nothing with no tabs open", () => {
    expect(tabsReducer(emptyTabs, { type: "cycle", direction: 1, at: 9 }).state).toEqual(emptyTabs);
  });

  it("starts from the first tab when nothing is active", () => {
    const orphan = state([{ id: "/a" }, { id: "/b" }], null);
    expect(tabsReducer(orphan, { type: "cycle", direction: 1, at: 9 }).state.activeId).toBe("/b");
  });
});

describe("purity — the reducer never mutates what it was given", () => {
  it("leaves the input untouched on every action", () => {
    const s = state([{ id: "/a", isDraft: true }, { id: "/b" }], "/a");
    const snapshot = JSON.stringify(s);
    tabsReducer(s, { type: "open", url: "/c", title: "C", at: 1 });
    tabsReducer(s, { type: "close", id: "/b" });
    tabsReducer(s, { type: "setDraft", id: "/b", isDraft: true });
    tabsReducer(s, { type: "cycle", direction: 1, at: 2 });
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it("takes the clock as a parameter, so it is testable at any moment", () => {
    // A reducer that reads Date.now() cannot be tested for eviction order.
    const r = open(emptyTabs, "/a", 1234);
    expect(r.state.tabs[0].lastAccessedAt).toBe(1234);
  });
});

describe("background open — found in the browser, not by a test", () => {
  // A Ctrl+click opened the tab AND made it active, so the address bar jumped to
  // the new page while the content stayed on the old one. A modified click means
  // "put this somewhere for later" everywhere else.
  const bgOpen = (s: TabsState, url: string, at = 100) =>
    tabsReducer(s, { type: "open", url, title: url, at, background: true });

  it("adds the tab without stealing focus", () => {
    const s = state([{ id: "/customers" }], "/customers");
    const r = bgOpen(s, "/quotes");
    expect(r.state.tabs.map((t) => t.id)).toEqual(["/customers", "/quotes"]);
    expect(r.state.activeId).toBe("/customers");
  });

  it("does not steal focus for a page that is already open either", () => {
    const s = state([{ id: "/a" }, { id: "/b" }], "/a");
    expect(bgOpen(s, "/b").state.activeId).toBe("/a");
  });

  it("still focuses when there was nothing active to keep", () => {
    // Opening the first tab in the background would otherwise leave the workspace
    // with tabs and no active one, and nothing to render.
    expect(bgOpen(emptyTabs, "/first").state.activeId).toBe("/first");
  });

  it("focuses the new tab when eviction removed the ACTIVE one", () => {
    // Focus has to land somewhere, and the new tab is the only sensible place.
    const s = state(
      Array.from({ length: MAX_TABS }, (_, i) => ({ id: `/t${i}`, lastAccessedAt: i })),
      "/t0",   // the active tab is also the oldest, so it gets evicted
    );
    const r = bgOpen(s, "/new", 999);
    expect(r.state.tabs.map((t) => t.id)).not.toContain("/t0");
    expect(r.state.activeId).toBe("/new");
  });

  it("keeps focus when eviction removed a tab that was NOT active", () => {
    const s = state(
      Array.from({ length: MAX_TABS }, (_, i) => ({ id: `/t${i}`, lastAccessedAt: i })),
      "/t5",
    );
    const r = bgOpen(s, "/new", 999);
    expect(r.state.activeId).toBe("/t5");
  });

  it("a foreground open still focuses, as before", () => {
    const s = state([{ id: "/a" }], "/a");
    expect(tabsReducer(s, { type: "open", url: "/b", title: "B", at: 1 }).state.activeId).toBe("/b");
  });
});
