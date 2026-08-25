import { describe, it, expect } from "vitest";
import { shortPlan, planWasShortened } from "./short-plan";

/* ══ THE ONE THAT MATTERS ════════════════════════════════════════════════════ */

describe("two products never collapse into one label", () => {
  it("keeps the three Standards apart", () => {
    /* ─── MEASURED AGAINST THE REAL CATALOGUE ────────────────────────────────
       This tenant sells all three. Dropping the vendor — the obvious way to stop the
       column clipping — makes the first two identical on a page where every row
       carries a rupee figure. */
    const shortened = [
      "Google Workspace Business Standard",
      "Microsoft 365 Business Standard",
      "Zoho Workplace Standard",
      "Standard",
    ].map(shortPlan);

    expect(shortened).toEqual([
      "GW · Business Standard",
      "M365 · Business Standard",
      "Zoho · Standard",
      "Standard",
    ]);
    /* the real assertion: still four distinct labels */
    expect(new Set(shortened).size).toBe(4);
  });

  it("leaves every name in the catalogue distinct", () => {
    /* The full item list for this tenant, 25 Aug 2026. If a future vendor entry made two
       of these read the same, this fails rather than shipping an ambiguous money screen. */
    const catalogue = [
      "ANUTECH DIGITAL PVT LTD Enterprise Support",
      "ANUTECH DIGITAL PVT LTD Free Support",
      "ANUTECH DIGITAL PVT LTD Standard Support",
      "AppSheet Core", "Basic", "Custom Software Development", "Free",
      "Google Workspace Business Plus",
      "Google Workspace Business Standard",
      "Google Workspace Business Starter",
      "Google Workspace Enterprise",
      "Microsoft 365 Business Basic",
      "Microsoft 365 Business Premium",
      "Microsoft 365 Business Standard",
      "Moderate", "Plus", "Premium", "Standard", "Starter",
      "Zoho Workplace Professional",
      "Zoho Workplace Standard",
    ];
    const out = catalogue.map(shortPlan);
    expect(new Set(out).size).toBe(catalogue.length);
  });
});

/* ══ The closed list ═════════════════════════════════════════════════════════ */

describe("only names it recognises are rewritten", () => {
  it("does not touch a plan with no known vendor", () => {
    /* A "first two words are the vendor" rule would turn this into "CS · Development",
       and the catalogue really does contain it. */
    for (const name of ["Custom Software Development", "AppSheet Core", "Starter", "Free"]) {
      expect(shortPlan(name)).toBe(name);
    }
  });

  it("does not touch the reseller's own support items", () => {
    const name = "ANUTECH DIGITAL PVT LTD Standard Support";
    expect(shortPlan(name)).toBe(name);
  });

  it("prefers the longest matching vendor", () => {
    /* "Google Workspace" must win over any shorter "Google" rule added later. */
    expect(shortPlan("Google Workspace Enterprise")).toBe("GW · Enterprise");
  });

  it("keeps the full name when the plan IS just the vendor", () => {
    /* "GW · " with nothing after it reads as a rendering fault. */
    expect(shortPlan("Google Workspace")).toBe("Google Workspace");
    expect(shortPlan("Microsoft 365")).toBe("Microsoft 365");
  });

  it("matches the vendor case-insensitively but keeps the plan's own casing", () => {
    expect(shortPlan("GOOGLE WORKSPACE Business Starter")).toBe("GW · Business Starter");
  });
});

/* ══ Edges ═══════════════════════════════════════════════════════════════════ */

describe("empty and missing", () => {
  it("returns an empty string for nothing at all", () => {
    for (const v of [null, undefined, "", "   "]) expect(shortPlan(v)).toBe("");
  });

  it("trims before deciding", () => {
    expect(shortPlan("  Google Workspace Business Plus  ")).toBe("GW · Business Plus");
  });
});

describe("planWasShortened", () => {
  it("is true only when the label actually changed", () => {
    expect(planWasShortened("Google Workspace Business Starter")).toBe(true);
    expect(planWasShortened("Standard")).toBe(false);
    expect(planWasShortened("Google Workspace")).toBe(false);
    expect(planWasShortened(null)).toBe(false);
    expect(planWasShortened("")).toBe(false);
  });

  it("agrees with shortPlan on every catalogue name", () => {
    /* The cell only needs a tooltip when something was hidden; if these two ever
       disagree, a row would either lose the full name or carry a pointless tooltip. */
    for (const name of ["Google Workspace Enterprise", "Microsoft 365 Business Basic", "Premium", "Free"]) {
      expect(planWasShortened(name)).toBe(shortPlan(name) !== name);
    }
  });
});

/* ══ What it buys ════════════════════════════════════════════════════════════ */

describe("the width it saves", () => {
  it("cuts the longest Google name by twelve characters", () => {
    const long = "Google Workspace Business Standard";
    expect(long.length).toBe(34);
    expect(shortPlan(long).length).toBe(22);
  });
});
