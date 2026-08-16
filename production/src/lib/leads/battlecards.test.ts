import { describe, it, expect } from "vitest";
import { BATTLECARDS, battlecardsFor, vendorFromPlan } from "./battlecards";

describe("BATTLECARDS — content rules", () => {
  it("covers the three vendors this reseller sells", () => {
    expect(BATTLECARDS.map((b) => b.vendor)).toEqual(["google", "microsoft", "zoho"]);
  });

  it("NEVER quotes a price, discount or delivery date", () => {
    /* Those change, they are per-customer, and a stale number in a battlecard is a
       promise a rep makes without knowing it is stale. Cards handle positioning; the
       quote handles numbers. */
    const forbidden = /₹|Rs\.?\s*\d|\bdiscount\b|\b\d+\s*%\s*off\b|\bwithin \d+ (days|hours)\b/i;
    for (const v of BATTLECARDS) {
      for (const c of v.cards) {
        expect(c.objection, `${v.vendor}: ${c.objection}`).not.toMatch(forbidden);
        expect(c.response,  `${v.vendor}: ${c.objection}`).not.toMatch(forbidden);
        if (c.avoid) expect(c.avoid).not.toMatch(forbidden);
      }
    }
  });

  it("states where each vendor genuinely wins, so reps do not oversell", () => {
    for (const v of BATTLECARDS) {
      expect(v.strength.length).toBeGreaterThan(30);
      expect(v.cards.length).toBeGreaterThan(0);
    }
  });

  it("every response is short enough to read mid-call", () => {
    for (const v of BATTLECARDS) {
      for (const c of v.cards) {
        expect(c.response.length, `${v.vendor}: ${c.objection}`).toBeLessThan(420);
      }
    }
  });

  it("carries the honest concessions rather than only the wins", () => {
    /* A card set that never concedes anything is a card set reps stop trusting the
       first time a customer is right. */
    const all = BATTLECARDS.flatMap((v) => v.cards.map((c) => c.response)).join(" ").toLowerCase();
    expect(all).toMatch(/honest answer|often is|thinner|not true|less than/);
  });

  it("warns about the NCE commitment the code actually enforces", () => {
    const ms = battlecardsFor("microsoft")!;
    const nce = ms.cards.find((c) => /cancel/i.test(c.objection))!;
    expect(nce.response).toMatch(/7 days/);
    expect(nce.avoid).toMatch(/mid-term/i);
  });

  it("refuses to state data residency from memory", () => {
    const g = battlecardsFor("google")!;
    const dr = g.cards.find((c) => /data/i.test(c.objection))!;
    expect(dr.avoid).toMatch(/never state a specific country/i);
  });
});

describe("battlecardsFor", () => {
  it("finds a vendor's set", () => {
    expect(battlecardsFor("zoho")!.label).toBe("Zoho");
  });

  it("returns null for nothing, rather than defaulting to a vendor", () => {
    expect(battlecardsFor(null)).toBeNull();
    expect(battlecardsFor(undefined)).toBeNull();
  });
});

describe("vendorFromPlan", () => {
  it.each([
    ["Google Workspace Business Starter", "google"],
    ["GWS Enterprise",                    "google"],
    ["Microsoft 365 Business Premium",    "microsoft"],
    ["Office 365 E3",                     "microsoft"],
    ["Zoho Workplace Standard",           "zoho"],
  ] as const)("%s -> %s", (plan, vendor) => {
    expect(vendorFromPlan(plan)).toBe(vendor);
  });

  it("returns NULL for a plan that names no vendor — never a default", () => {
    /* Opening the Google cards for a Zoho deal puts the wrong words in a rep's mouth,
       which is worse than making them pick. */
    for (const p of ["Custom Cloud SaaS Solution", "Tally Prime Gold License", "", null, undefined]) {
      expect(vendorFromPlan(p as string | null)).toBeNull();
    }
  });

  it("is case-insensitive", () => {
    expect(vendorFromPlan("google workspace")).toBe("google");
    expect(vendorFromPlan("ZOHO MAIL")).toBe("zoho");
  });
});
