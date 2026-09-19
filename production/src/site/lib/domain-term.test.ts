import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { termSuffix } from "./domain-search";

describe("termSuffix — a price without its term is only safe while every term is a year", () => {
  it("says nothing at one year — the reader already assumes it", () => {
    expect(termSuffix(1)).toBe("");
  });
  it("speaks up for a multi-year minimum", () => {
    /* .ai on the live account: 8,807 buys TWO years, and there is no 1-year
       price at all. "₹8,807" alone states a term that cannot be bought. */
    expect(termSuffix(2)).toBe(" for 2 years");
    expect(termSuffix(10)).toBe(" for 10 years");
  });
  it("treats a missing or nonsense term as a year rather than throwing", () => {
    /* The engine fallback path sends no `years`, and it only ever quoted
       annually — so absent means 1, not unknown. */
    for (const bad of [undefined, null, NaN, 0, -3, Infinity]) {
      expect(termSuffix(bad as number)).toBe("");
    }
  });
  it("rounds rather than printing a fraction", () => {
    expect(termSuffix(2.4)).toBe(" for 2 years");
  });
});

describe("both marketing search surfaces use it", () => {
  /* A source pin. The portal card states the term always, because a ticket needs
     it written down; these two are dense lists and stay silent at one year — but
     they must not be silent at two, and only this catches a renderer that
     forgets.

     Measured 17 Sep 2026: of the three marketing search components only
     DomainLanding is RENDERED — /domains imports it. home/DomainSearch.tsx and
     home/DomainSearchDock.tsx have zero importers anywhere in src/. The first is
     pinned here anyway, deliberately: it is the one somebody would wire back up,
     and it should not come back missing the term. The dock is left out because
     it renders no price at all. */
  const root = process.cwd();
  const FILES = [
    "src/site/components/home/DomainSearch.tsx",
    "src/site/components/domains/DomainLanding.tsx",
  ];
  it.each(FILES)("%s renders termSuffix beside the price", (rel) => {
    expect(readFileSync(join(root, rel), "utf8")).toContain("termSuffix");
  });
});
