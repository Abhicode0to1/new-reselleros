import { describe, it, expect } from "vitest";
import { planKey, buildPlanIndex, matchPlan, type CatalogRow } from "./plan-match";

/**
 * The real `items` rows, read from the database on 14 Aug 2026.
 * cost = prices.annual.wholesale, ₹/seat/month.
 */
const CATALOG: CatalogRow[] = [
  { vendor: "google",    name: "AppSheet Core",                     costPerSeatMonth: 720 },
  { vendor: "google",    name: "Google Workspace Business Starter", costPerSeatMonth: 110 },
  { vendor: "google",    name: "Google Workspace Enterprise",       costPerSeatMonth: 2050 },
  { vendor: "google",    name: "Google Workspace Plus",             costPerSeatMonth: 1150 },
  { vendor: "google",    name: "Google Workspace Standard",         costPerSeatMonth: 620 },
  { vendor: "microsoft", name: "Microsoft 365 Business Basic",      costPerSeatMonth: 165 },
  { vendor: "microsoft", name: "Microsoft 365 Business Premium",    costPerSeatMonth: 1620 },
  { vendor: "microsoft", name: "Microsoft 365 Business Standard",   costPerSeatMonth: 820 },
  { vendor: "zoho",      name: "Zoho Workplace Professional",       costPerSeatMonth: 220 },
  { vendor: "zoho",      name: "Zoho Workplace Standard",           costPerSeatMonth: 95 },
  { vendor: "hosting",   name: "Starter",                           costPerSeatMonth: 0 },
  { vendor: "hosting",   name: "Standard",                          costPerSeatMonth: 0 },
  { vendor: "hosting",   name: "Plus",                              costPerSeatMonth: 0 },
  { vendor: "support",   name: "Basic",                             costPerSeatMonth: 0 },
  { vendor: "support",   name: "Free",                              costPerSeatMonth: 0 },
  { vendor: "support",   name: "Moderate",                          costPerSeatMonth: 0 },
  { vendor: "support",   name: "Premium",                           costPerSeatMonth: 0 },
  { vendor: "other",     name: "Custom Software Development",       costPerSeatMonth: 0 },
  { vendor: "other",     name: "Custom software development for company billing", costPerSeatMonth: 0 },
];

/** What add-subscription-dialog.tsx:34 actually writes into subscriptions.plan. */
const DIALOG_WRITES: Array<[string, string]> = [
  ["google", "Google Workspace Business Starter"],
  ["google", "Google Workspace Business Standard"],
  ["google", "Google Workspace Business Plus"],
  ["google", "Google Workspace Enterprise Starter"],
  ["google", "Google Workspace Enterprise Standard"],
  ["google", "Google Workspace Enterprise Plus"],
  ["google", "Google Workspace Individual"],
  ["google", "Google Vault Add-on"],
  ["google", "Google Cloud Platform (GCP) Credits"],
  ["microsoft", "Microsoft 365 Business Basic"],
  ["microsoft", "Microsoft 365 Business Standard"],
  ["microsoft", "Microsoft 365 Business Premium"],
  ["microsoft", "Microsoft 365 Apps for Business"],
  ["microsoft", "Office 365 E1"],
  ["microsoft", "Office 365 E3"],
  ["microsoft", "Office 365 E5"],
  ["microsoft", "Microsoft Teams Essentials"],
  ["microsoft", "Exchange Online Plan 1"],
  ["microsoft", "Microsoft Azure Cloud Subscription"],
  ["zoho", "Zoho Workplace Standard"],
  ["zoho", "Zoho Workplace Professional"],
  ["zoho", "Zoho One (All-in-One)"],
  ["zoho", "Zoho Mail Lite"],
  ["zoho", "Zoho CRM Professional"],
  ["zoho", "Zoho Books Professional"],
  ["other", "Custom Cloud SaaS Solution"],
  ["other", "Domain Registration & DNS"],
  ["other", "SSL Certificate (Wildcard)"],
  ["other", "Tally Prime Gold License"],
];

const index = buildPlanIndex(CATALOG);

describe("planKey", () => {
  it("is applied identically to both sides — that is the whole safety property", () => {
    expect(planKey("Google Workspace Business Standard")).toBe(planKey("Google Workspace Standard"));
    expect(planKey("Google Workspace Business Starter")).toBe(planKey("Google Workspace Business Starter"));
  });

  it("normalises case, punctuation and spacing", () => {
    expect(planKey("Google  Workspace   PLUS")).toBe("google workspace plus");
    expect(planKey("Google Cloud Platform (GCP) Credits")).toBe("google cloud platform gcp credits");
    expect(planKey("Domain Registration & DNS")).toBe("domain registration dns");
    expect(planKey("Google Vault Add-on")).toBe("google vault add on");
  });

  it("returns empty for nothing, so an unnamed plan matches nothing", () => {
    for (const v of [null, undefined, "", "   "]) expect(planKey(v)).toBe("");
  });

  it("does not collapse two DIFFERENT catalog products onto one key", () => {
    // The check that would catch a filler word being too aggressive. If this ever
    // fails, the normaliser has started merging real products.
    const keys = CATALOG.map((r) => `${r.vendor}|${planKey(r.name)}`);
    expect(new Set(keys).size).toBe(CATALOG.length);
  });
});

describe("buildPlanIndex + matchPlan — against the real catalog", () => {
  it("finds the highest-volume Google plans that an EXACT match misses", () => {
    // The two the old approach would have been silent on.
    expect(matchPlan(index, "google", "Google Workspace Business Standard"))
      .toEqual({ matched: true, costPerSeatMonth: 620 });
    expect(matchPlan(index, "google", "Google Workspace Business Plus"))
      .toEqual({ matched: true, costPerSeatMonth: 1150 });
  });

  it("still finds the ones that already matched exactly", () => {
    expect(matchPlan(index, "google", "Google Workspace Business Starter"))
      .toEqual({ matched: true, costPerSeatMonth: 110 });
    expect(matchPlan(index, "microsoft", "Microsoft 365 Business Premium"))
      .toEqual({ matched: true, costPerSeatMonth: 1620 });
    expect(matchPlan(index, "zoho", "Zoho Workplace Standard"))
      .toEqual({ matched: true, costPerSeatMonth: 95 });
  });

  it("REFUSES to map three Enterprise tiers onto the one Enterprise price", () => {
    /* The catalog has a single "Google Workspace Enterprise" at ₹2,050 while the
       dialog sells Starter / Standard / Plus. Guessing would put an invented cost
       behind a real margin number. Unmatched is the correct answer. */
    for (const tier of ["Starter", "Standard", "Plus"]) {
      expect(matchPlan(index, "google", `Google Workspace Enterprise ${tier}`))
        .toEqual({ matched: false, reason: "no_such_plan" });
    }
    // The plain Enterprise row itself still matches.
    expect(matchPlan(index, "google", "Google Workspace Enterprise"))
      .toEqual({ matched: true, costPerSeatMonth: 2050 });
  });

  it("never matches across vendors", () => {
    // "Standard" exists under google, hosting and support. A vendor mix-up would
    // price a Google seat at the hosting cost of zero — a 100% margin out of thin air.
    expect(matchPlan(index, "hosting", "Google Workspace Standard").matched).toBe(false);
    expect(matchPlan(index, "google", "Standard").matched).toBe(false);
    // "Standard" is a hosting row; support's tiers are Basic/Free/Moderate/Premium.
    // (A first version of this test asserted support — the bare tier names are easy
    // to attribute to the wrong vendor by eye, which is the point of the test.)
    expect(matchPlan(index, "hosting", "Standard")).toEqual({ matched: true, costPerSeatMonth: 0 });
    expect(matchPlan(index, "support", "Standard").matched).toBe(false);
  });

  it("matches nothing on a missing vendor or plan", () => {
    expect(matchPlan(index, null, "Google Workspace Standard").matched).toBe(false);
    expect(matchPlan(index, "google", null).matched).toBe(false);
    expect(matchPlan(index, "google", "   ").matched).toBe(false);
  });

  it("measures the coverage this normaliser actually buys", () => {
    const exact = new Set(CATALOG.map((r) => `${r.vendor}|${r.name.trim().toLowerCase()}`));
    const exactHits = DIALOG_WRITES.filter(([v, n]) => exact.has(`${v}|${n.trim().toLowerCase()}`)).length;
    const keyHits   = DIALOG_WRITES.filter(([v, n]) => matchPlan(index, v, n).matched).length;

    // Measured, not hoped for: 6 -> 8 of the dialog's 29 products.
    expect(DIALOG_WRITES).toHaveLength(29);
    expect(exactHits).toBe(6);
    expect(keyHits).toBe(8);

    /* 8 of 29 is still poor, and it is poor for a REAL reason, not a matching one:
       21 of those products have no catalog row at all, so no amount of string work
       can price them. The fix is a catalog with an id on the subscription, not a
       cleverer normaliser — and until then those rows are reported as unpriced
       rather than assumed healthy. */
    const noRow = DIALOG_WRITES.filter(([v, n]) => {
      const m = matchPlan(index, v, n);
      return !m.matched && m.reason === "no_such_plan";
    });
    expect(noRow).toHaveLength(21);
  });
});

describe("buildPlanIndex — disagreeing duplicates", () => {
  it("marks a key ambiguous when two rows give different costs, and matches neither", () => {
    const idx = buildPlanIndex([
      { vendor: "google", name: "Google Workspace Business Standard", costPerSeatMonth: 620 },
      { vendor: "google", name: "Google Workspace Standard",          costPerSeatMonth: 700 },
    ]);
    expect(matchPlan(idx, "google", "Google Workspace Standard"))
      .toEqual({ matched: false, reason: "ambiguous" });
  });

  it("tolerates a duplicate that AGREES — same product, same price, no problem", () => {
    const idx = buildPlanIndex([
      { vendor: "google", name: "Google Workspace Business Standard", costPerSeatMonth: 620 },
      { vendor: "google", name: "Google Workspace Standard",          costPerSeatMonth: 620 },
    ]);
    expect(matchPlan(idx, "google", "Google Workspace Standard"))
      .toEqual({ matched: true, costPerSeatMonth: 620 });
  });

  it("ignores an unnamed catalog row instead of indexing it under the empty key", () => {
    const idx = buildPlanIndex([{ vendor: "google", name: "  ", costPerSeatMonth: 999 }]);
    expect(idx.costs.size).toBe(0);
  });
});
