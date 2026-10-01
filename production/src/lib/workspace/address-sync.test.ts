import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recordAddress, urlForTabSwitch } from "./address-sync";
import type { TabHistory } from "./history";
import type { TabsState, WorkspaceTab } from "./tabs";

/* R-068 — opening /leads directly, the app replaced it with /renewals by itself, repeatedly.
   The sessionStorage that did it, copied from the live browser: */
const tab = (id: string): WorkspaceTab => ({ id, url: id, title: id, isDraft: false, lastAccessedAt: 1 });
const OBSERVED_STACK = ["/leads", "/renewals", "/leads", "/renewals", "/leads", "/renewals", "/leads"];
const onlyLeads: TabsState = { tabs: [tab("/leads")], activeId: "/leads" };

describe("R-068: the page the user opened is never replaced by a stored history entry", () => {
  it("loading /leads with the observed alternating history does not navigate anywhere", () => {
    const histories = { "/leads": { stack: OBSERVED_STACK, cursor: 6 } };
    // Hydration: no previous active tab.
    expect(urlForTabSwitch(null, onlyLeads, histories, "/leads")).toBeNull();
    // A later tabs-array change (draft flag) with the same active tab.
    expect(urlForTabSwitch("/leads", onlyLeads, histories, "/leads")).toBeNull();
  });

  it("…nor when the stored cursor points at /renewals", () => {
    const histories = { "/leads": { stack: OBSERVED_STACK, cursor: 5 } };
    expect(urlForTabSwitch(null, onlyLeads, histories, "/leads")).toBeNull();
    expect(urlForTabSwitch("/leads", onlyLeads, histories, "/leads")).toBeNull();
    // …and the history is brought into line with the address instead.
    const { activateId, histories: next } = recordAddress(onlyLeads, histories, "/leads");
    expect(activateId).toBeNull();
    expect(next["/leads"].stack[next["/leads"].cursor]).toBe("/leads");
    expect(urlForTabSwitch("/leads", onlyLeads, next, "/leads")).toBeNull();
  });

  it("a genuine tab switch still restores that tab's page", () => {
    const state: TabsState = { tabs: [tab("/leads"), tab("/customers")], activeId: "/customers" };
    const histories = { "/customers": { stack: ["/customers", "/customers/42"], cursor: 1 } };
    expect(urlForTabSwitch("/leads", state, histories, "/leads")).toBe("/customers/42");
    // …unless the address is already there (the switch was caused by the address).
    expect(urlForTabSwitch("/leads", state, histories, "/customers/42")).toBeNull();
  });
});

describe("R-068: an address is recorded in the tab that owns it", () => {
  it("navigating to an open tab's page activates that tab instead of filing it under the active one", () => {
    const state: TabsState = { tabs: [tab("/leads"), tab("/renewals")], activeId: "/leads" };
    const histories: Record<string, TabHistory> = { "/leads": { stack: ["/leads"], cursor: 0 } };
    const { activateId, histories: next } = recordAddress(state, histories, "/renewals");
    expect(activateId).toBe("/renewals");
    expect(next["/leads"]).toEqual({ stack: ["/leads"], cursor: 0 });
    expect(next["/renewals"].stack).toEqual(["/renewals"]);
  });

  it("switching tabs back and forth does not grow an alternating stack", () => {
    /* The old record effect also ran on an active-tab change and pushed the address still on
       screen (the OLD tab's page) into the NEW tab's history. Replay the switch loop through
       the provider's actual sequence: activate → replace to the tab's page → address changes. */
    let state: TabsState = { tabs: [tab("/leads"), tab("/renewals")], activeId: "/leads" };
    let histories: Record<string, TabHistory> = {};
    let address = "/leads";
    ({ histories } = recordAddress(state, histories, address));
    for (let i = 0; i < 3; i++) {
      for (const id of ["/renewals", "/leads"]) {
        const prev = state.activeId;
        state = { ...state, activeId: id };
        const target = urlForTabSwitch(prev, state, histories, address);
        if (target) address = target;
        const r = recordAddress(state, histories, address);
        histories = r.histories;
        expect(r.activateId).toBeNull();
      }
    }
    expect(histories["/leads"]).toEqual({ stack: ["/leads"], cursor: 0 });
    expect(histories["/renewals"]).toEqual({ stack: ["/renewals"], cursor: 0 });
  });

  it("an ordinary link inside the tab is still in-tab history (Back works)", () => {
    const { activateId, histories } = recordAddress(onlyLeads, {}, "/leads/L-1");
    expect(activateId).toBeNull();
    expect(histories["/leads"]).toEqual({ stack: ["/leads", "/leads/L-1"], cursor: 1 });
  });
});

describe("R-068: the provider uses these decisions", () => {
  const PROVIDER = readFileSync(
    join(process.cwd(), "src", "components", "providers", "workspace-tabs-provider.tsx"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("only replaces the URL through urlForTabSwitch", () => {
    expect(PROVIDER).toMatch(/urlForTabSwitch\(/);
    // The old unconditional read of the history cursor as a replace target is gone.
    expect(PROVIDER).not.toMatch(/historiesRef\.current\[tab\.id\]\.stack\[/);
  });

  it("records only on an address change, never on an active-tab change", () => {
    const m = PROVIDER.match(/recordAddress\([\s\S]*?\}, \[([^\]]*)\]\);/);
    expect(m, "record effect uses recordAddress").not.toBeNull();
    expect(m![1]).not.toMatch(/activeId/);
  });
});
