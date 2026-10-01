import { describe, it, expect } from "vitest";
import { quotesEmptyCopy } from "./empty-tab";

describe("quotes empty tab copy (R-063)", () => {
  it("Subscription tab empty while Project has 2 — says so, offers the switch", () => {
    const c = quotesEmptyCopy("subscription", 2);
    expect(c.title).toBe("No subscription quotes");
    expect(c.body).toBe("2 project quotes in the Project tab.");
    expect(c.switchLabel).toBe("Show project quotes");
    expect(c.title).not.toMatch(/yet/);
  });

  it("singular, and the reverse direction", () => {
    expect(quotesEmptyCopy("subscription", 1).body).toBe("1 project quote in the Project tab.");
    const p = quotesEmptyCopy("project", 3);
    expect(p).toEqual({ title: "No project quotes", body: "3 subscription quotes in the Subscription tab.", switchLabel: "Show subscription quotes" });
  });

  it("both empty — the first-quote nudge, no switch", () => {
    expect(quotesEmptyCopy("subscription", 0)).toMatchObject({ title: "No quotes yet", switchLabel: null });
    expect(quotesEmptyCopy("project", 0).switchLabel).toBeNull();
  });
});
