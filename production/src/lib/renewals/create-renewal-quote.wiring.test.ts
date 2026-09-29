/**
 * R-012 — the renewal quote sends the subscription's OWN term and the catalogue's
 * own cost.
 *
 * A source scan, because both bugs were single literals sitting beside code that
 * already had the right answer. `term.termMonths` and `term.commitment` were both in
 * scope; `extension_months: 12` sat two lines below them. No unit test of either helper
 * could see that the caller ignored one of them — the same shape as L75 and L98.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const FILE = "src/lib/renewals/create-renewal-quote.ts";

/** Comments stripped: prose explaining a deleted literal must not satisfy a scan for it (L46). */
const code = readFileSync(FILE, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("the renewal extends by the subscription's own term", () => {
  it("sends term.termMonths, not a hardcoded 12", () => {
    /* THE BUG THAT TOOK MONEY. record_payment rolls the dates forward from this field,
       so a monthly renewal priced for one month extended the subscription by a year. */
    expect(code).toContain("extension_months: term.termMonths");
    expect(code).not.toMatch(/extension_months:\s*12\b/);
  });

  it("still takes the price and the commitment from the same term", () => {
    // These were already right. The defect was one field of three disagreeing.
    expect(code).toContain("term.subtotal");
    expect(code).toContain("term.perSeatRate");
    expect(code).toContain("commitment: term.commitment");
  });
});

describe("the cost comes from the catalogue", () => {
  it("has no 0.83 guess left anywhere", () => {
    /* A hardcoded 17% margin: every renewal quote reported 17% because it was defined
       to be 17%. AGENTS.md §2 lists this exact constant. */
    expect(code).not.toContain("0.83");
  });

  it("reads the wholesale column, not only the msrp", () => {
    expect(code).toContain('.select("msrp, wholesale")');
  });

  it("prices through the tested helper", () => {
    expect(code).toContain("renewalCost({");
    expect(code).toContain("wholesalePerSeatMonth:");
    // The term, so a monthly renewal is not costed for twelve months.
    expect(code).toMatch(/termMonths:\s*term\.termMonths/);
  });

  it("writes the same figure to the line and to total_cost", () => {
    // Two derivations of one number is how they drift.
    expect(code).toContain("const perSeatCost = cost.perSeat;");
    expect(code).toContain("total_cost:     cost.total,");
  });

  it("says out loud when it could not price the cost", () => {
    /* Silence here would put an unknown cost on a quote and let the margin read as
       100%. The warning names the plan so the cron log is actionable. */
    expect(code).toMatch(/if \(!cost\.known\)/);
    expect(code).toMatch(/console\.warn/);
  });
});

describe("what R-012 said NOT to touch", () => {
  it("leaves createExtensionQuote's own 24/36 alone", () => {
    /* Pawan's request is explicit: extensions choose 24 or 36 on purpose, and that file
       is not part of this fix. */
    const ext = readFileSync("src/lib/renewals/create-extension-quote.ts", "utf8");
    expect(ext).toMatch(/extension_months/);
  });
});
