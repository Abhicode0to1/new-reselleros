import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { syncableTlds, type TldPriceRow } from "./catalog-sync";

const row = (over: Partial<TldPriceRow>): TldPriceRow => ({
  tld: ".in",
  register: 863,
  renew: 947,
  transfer: 863,
  currency: "INR",
  ...over,
});

describe("syncableTlds", () => {
  it("passes an ordinary annual TLD through", () => {
    const plan = syncableTlds([row({})]);
    expect(plan.sync.map((r) => r.tld)).toEqual([".in"]);
    expect(plan.skipped).toEqual([]);
  });

  it("treats a missing term as annual — the engine's rows carry none", () => {
    /* The fallback path (no ResellerClub credentials) sends no `years`. Reading
       absent as "unknown" would reject every row it ever returns. */
    const plan = syncableTlds([row({ years: undefined })]);
    expect(plan.sync).toHaveLength(1);
  });

  it("keeps a 2-year-minimum TLD OUT of the annual rate card", () => {
    /* .ai, measured on the live account 17 Sep 2026: ₹8,807 register and ₹9,347
       renew, both for TWO years. Stored as-is, a renewal quote would say ₹9,347
       for one year — a real number answering a different question. */
    const plan = syncableTlds([row({ tld: ".ai", register: 8807, renew: 9347, years: 2 })]);
    expect(plan.sync).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].tld).toBe(".ai");
    expect(plan.skipped[0].reason).toContain("2-year minimum");
    expect(plan.skipped[0].reason).toContain("annual");
  });

  it("skips an unpriced TLD, and says which reason applies", () => {
    const plan = syncableTlds([row({ tld: ".xyz", register: null }), row({ tld: ".abc", register: 0 })]);
    expect(plan.sync).toEqual([]);
    expect(plan.skipped.map((s) => s.tld)).toEqual([".xyz", ".abc"]);
    for (const s of plan.skipped) expect(s.reason).toContain("no registration price");
  });

  it("sorts the good from the bad in one pass, keeping input order", () => {
    const plan = syncableTlds([
      row({ tld: ".in" }),
      row({ tld: ".ai", years: 2 }),
      row({ tld: ".com", register: 1199 }),
      row({ tld: ".xyz", register: null }),
    ]);
    expect(plan.sync.map((r) => r.tld)).toEqual([".in", ".com"]);
    expect(plan.skipped.map((s) => s.tld)).toEqual([".ai", ".xyz"]);
  });

  it("an empty card is a plan with nothing in it, not a throw", () => {
    expect(syncableTlds([])).toEqual({ sync: [], skipped: [] });
  });
});

describe("mergeTlds applies the same rule", () => {
  /* The site's rate card has the same annual columns and the same blind spot.
     One rule, imported, rather than a second copy that drifts. */
  it("a 2-year TLD does not overlay the placeholder", async () => {
    const { mergeTlds } = await import("@/site/lib/live-tld-pricing");
    const merged = mergeTlds([
      { tld: ".ai", register: 8807, renew: 9347, transfer: 9347, currency: "INR", years: 2 },
      { tld: ".in", register: 863, renew: 947, transfer: 863, currency: "INR", years: 1 },
    ]);
    const ai = merged.find((m) => m.tld === ".ai");
    const inr = merged.find((m) => m.tld === ".in");
    /* .ai keeps the placeholder and is NOT marked live — the page must not show
       a two-year figure in a column headed by the year. */
    expect(ai?.reg).toBe(6999);
    expect(ai?.live).toBeUndefined();
    /* .in overlays normally, so the guard is not just refusing everything. */
    expect(inr?.reg).toBe(863);
    expect(inr?.live).toBe(true);
  });
});

describe("the catalogue sync route uses it", () => {
  /* A source pin. The unit tests prove the rule; only this proves it is applied
     — and it is what fails if somebody restores the old inline filter. */
  const ROUTE = join(__dirname, "..", "..", "app", "api", "catalog", "sync-domains", "route.ts");

  it("goes through syncableTlds rather than filtering inline", () => {
    const src = readFileSync(ROUTE, "utf8");
    expect(src).toContain("syncableTlds");
    expect(src, "the old inline filter is back — it has no idea about terms").not.toMatch(
      /tlds\.filter\(\s*\(t\)\s*=>\s*typeof t\.register/,
    );
  });
});
