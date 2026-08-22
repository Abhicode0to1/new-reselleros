import { describe, it, expect } from "vitest";
import {
  categoriseByRules, categoriseBatch, directionOf,
  type CategoryRule, type BankLine,
} from "./categorise";

/* The three narrations below are REAL, copied out of bank_transactions on 22 Aug 2026.
   They are the whole reason this is rules-first rather than a model: the answer is written
   in the text. Invented test strings would have hidden how much noise a bank puts around
   the one word that matters. */
const REAL_SALARY  = "IMPS-621856395591-PARDEEP SHARMA-ICIC-XX XXXXXX4658-SALARY";
const REAL_GOOGLE  = "DHDF23P1QTMPV7/BILLDKPLAYSTOREGOOGL";
const REAL_FACEBOOK = "K4UHU5ENAJ52FPOTCU/PAYUFACEBOOK";

const rule = (over: Partial<CategoryRule> & { pattern: string; category: string }): CategoryRule => ({
  id: `r-${over.pattern}`,
  direction: "any",
  ...over,
});

/* Categories are the tenant's real eight, so no test asserts against a category the books
   do not actually have. */
const RULES: CategoryRule[] = [
  rule({ pattern: "SALARY",         category: "Salaries",  direction: "debit" }),
  rule({ pattern: "PLAYSTOREGOOGL", category: "Software" }),
  rule({ pattern: "PAYUFACEBOOK",   category: "Marketing" }),
];

const debit  = (description: string, amount = 1000): BankLine => ({ description, debit: amount, credit: 0 });
const credit = (description: string, amount = 1000): BankLine => ({ description, debit: 0, credit: amount });

describe("the three lines this was built for", () => {
  it("files a salary IMPS under Salaries", () => {
    const m = categoriseByRules(debit(REAL_SALARY, 150000), RULES);
    expect(m?.category).toBe("Salaries");
    /* The reason travels with the answer. An operator who cannot see WHY a line was
       categorised has to re-derive it, and will stop trusting the column. */
    expect(m?.reason).toBe("rule: SALARY");
  });

  it("files a Google Play charge under Software, through the surrounding noise", () => {
    expect(categoriseByRules(debit(REAL_GOOGLE, 3024), RULES)?.category).toBe("Software");
  });

  it("files a PayU-Facebook charge under Marketing", () => {
    expect(categoriseByRules(debit(REAL_FACEBOOK, 5000), RULES)?.category).toBe("Marketing");
  });
});

describe("direction is a correctness guard, not a nicety", () => {
  it("does not call an incoming SALARY an expense", () => {
    /* Money coming IN with "salary" in the narration is a refund or a reversal. A
       direction-blind rule would file it under Salaries and overstate the wage bill —
       which is a real accounting error, not a cosmetic one. */
    expect(categoriseByRules(credit(REAL_SALARY, 150000), RULES)).toBeNull();
  });

  it("still matches an `any` rule on either side", () => {
    const anyRule = [rule({ pattern: "INTEREST", category: "Bank Charges" })];
    expect(categoriseByRules(debit("MONTHLY INTEREST", 50), anyRule)?.category).toBe("Bank Charges");
    expect(categoriseByRules(credit("SAVINGS INTEREST", 50), anyRule)?.category).toBe("Bank Charges");
  });

  it("refuses a line that is neither a debit nor a credit, and one that is both", () => {
    /* A zero row, and a malformed row. Picking a direction for either is how a rule fires
       on a line nobody can classify. */
    expect(directionOf({ description: REAL_SALARY, debit: 0, credit: 0 })).toBeNull();
    expect(directionOf({ description: REAL_SALARY, debit: 100, credit: 100 })).toBeNull();
    expect(categoriseByRules({ description: REAL_SALARY, debit: 100, credit: 100 }, RULES)).toBeNull();
  });
});

describe("no match is an answer, and must stay distinguishable", () => {
  it("returns null rather than guessing", () => {
    expect(categoriseByRules(debit("NEFT-XX9931-SOME NEW VENDOR PVT LTD"), RULES)).toBeNull();
  });

  it("returns null for an empty narration instead of matching an empty pattern", () => {
    expect(categoriseByRules(debit(""), RULES)).toBeNull();
    expect(categoriseByRules({ description: null, debit: 10, credit: 0 }, RULES)).toBeNull();
  });

  it("ignores a blank rule instead of letting it swallow the statement", () => {
    /* One blank pattern row would otherwise match every line in the file. This is the
       cheapest possible bug to create from a UI and the most expensive to notice. */
    const blank = [rule({ pattern: "   ", category: "Office Supplies" })];
    expect(categoriseByRules(debit(REAL_FACEBOOK), blank)).toBeNull();
  });
});

describe("the same line always gets the same answer", () => {
  it("prefers the more specific pattern over the shorter one", () => {
    const rules = [
      rule({ pattern: "GOOGLE",    category: "Software" }),
      rule({ pattern: "GOOGLEADS", category: "Marketing" }),
    ];
    expect(categoriseByRules(debit("PAYMENT/GOOGLEADS/12345"), rules)?.category).toBe("Marketing");
  });

  it("prefers a direction-specific rule over an `any` rule", () => {
    const rules = [
      rule({ pattern: "TRANSFER", category: "Office Supplies" }),
      rule({ pattern: "TRANSFER", category: "Salaries", direction: "debit", id: "r-specific" }),
    ];
    expect(categoriseByRules(debit("IMPS TRANSFER"), rules)?.category).toBe("Salaries");
  });

  it("does not depend on the order Postgres returned the rules in", () => {
    /* A `select` without `order by` may hand back rows in any order. If the answer moved
       with it, this categoriser would be non-deterministic even though every individual
       comparison is sound — and a month that reconciles today would stop reconciling
       tomorrow with no change to the data. */
    const a = rule({ pattern: "AMAZON", category: "Office Supplies", id: "r-1" });
    const b = rule({ pattern: "AMAZON", category: "Software",        id: "r-2" });
    const line = debit("PAYMENT TO AMAZON RETAIL");
    expect(categoriseByRules(line, [a, b])?.category).toBe("Office Supplies");
    expect(categoriseByRules(line, [b, a])?.category).toBe("Office Supplies");
  });

  it("is case- and whitespace-insensitive on both sides", () => {
    const rules = [rule({ pattern: "  payu facebook  ", category: "Marketing" })];
    expect(categoriseByRules(debit("K4U/PAYU   FACEBOOK/AD"), rules)?.category).toBe("Marketing");
  });
});

describe("a batch reports what it could NOT do", () => {
  it("splits matched from unmatched", () => {
    /* The leftovers are Phase 3's input and the honest measure of coverage. A function
       returning only successes would make a half-covered statement look finished. */
    const lines = [
      debit(REAL_SALARY, 150000),
      debit(REAL_GOOGLE, 3024),
      debit("NEFT-UNKNOWN VENDOR", 900),
      credit(REAL_SALARY, 150000),
    ];
    const { matched, unmatched } = categoriseBatch(lines, RULES);
    expect(matched.map((m) => m.match.category)).toEqual(["Salaries", "Software"]);
    expect(unmatched).toHaveLength(2);
    /* Nothing is lost or double-counted between the two lists. */
    expect(matched.length + unmatched.length).toBe(lines.length);
  });

  it("returns everything as unmatched when a tenant has no rules yet", () => {
    /* Day one, before anything is seeded. It must be empty-handed, not wrong. */
    const { matched, unmatched } = categoriseBatch([debit(REAL_SALARY)], []);
    expect(matched).toHaveLength(0);
    expect(unmatched).toHaveLength(1);
  });
});

/* ── The two layers together ───────────────────────────────────────────────────
   These assertions MEASURE which layer answers, rather than only that something did.
   That matters because the whole justification for having two is that each reaches cases
   the other cannot, and if the built-in list quietly covered everything the tenant-rule
   table would be dead weight nobody noticed. */
import { suggestForLine, suggestBatch } from "./categorise";
import { suggestCategory } from "@/lib/queries/expenses";

describe("tenant rules and the built-in keyword list, in that order", () => {
  it("proves the built-in list CANNOT read a machine narration", () => {
    /* The reason tenant rules exist. suggestCategory's patterns are \b-anchored because it
       was written for text an operator types; BILLDKPLAYSTOREGOOGL has no word boundary
       before GOOGL, so no anchored pattern can ever reach it. Asserted, not assumed —
       if this ever starts returning a category, the two-layer design needs revisiting. */
    expect(suggestCategory(REAL_GOOGLE)).toBeNull();
    expect(suggestCategory(REAL_FACEBOOK)).toBeNull();

    // ...and the tenant rule does reach it.
    expect(suggestForLine(debit(REAL_GOOGLE), RULES, suggestCategory)).toMatchObject({
      category: "Software", layer: "tenant-rule",
    });
  });

  it("proves the built-in list refuses Salaries, which is why the rule layer owns it", () => {
    /* suggestCategory's own comment: "'Salaries' is intentionally never guessed (those
       belong in Payroll)". Correct for a typed note, wrong for a bank statement where
       ...-SALARY is precisely a salary payment. */
    expect(suggestCategory(REAL_SALARY)).toBeNull();
    expect(suggestForLine(debit(REAL_SALARY, 150000), RULES, suggestCategory)).toMatchObject({
      category: "Salaries", layer: "tenant-rule",
    });
  });

  it("falls through to the built-in list on a human-readable narration", () => {
    /* And here the built-in layer earns its place: no tenant rule covers this, and the
       shared keyword list already knows it. */
    const hit = suggestForLine(debit("NEFT DR-BANK CHARGE FOR RTGS"), RULES, suggestCategory);
    expect(hit).toMatchObject({ category: "Bank Charges", layer: "builtin-keyword" });
    expect(hit?.reason).toBe("keyword match");
  });

  it("prefers the tenant rule when BOTH layers have an answer", () => {
    /* The learned, tenant-specific decision must win over the shared default, or
       corrections made in Phase 4 would be silently overridden by the global list. */
    const rules = [rule({ pattern: "HOSTING", category: "Software" })];
    expect(suggestCategory("AWS HOSTING RENEWAL")).toBe("Hosting");          // built-in says Hosting
    expect(suggestForLine(debit("AWS HOSTING RENEWAL"), rules, suggestCategory)).toMatchObject({
      category: "Software", layer: "tenant-rule",                            // tenant wins
    });
  });

  it("returns null when neither layer knows, instead of picking something", () => {
    expect(suggestForLine(debit("NEFT-XX9931-QRSTU ENTERPRISES"), RULES, suggestCategory)).toBeNull();
  });

  it("keeps a null suggestion in the batch rather than dropping the row", () => {
    /* A row silently missing from the result is worse than one marked uncategorised: the
       operator would import a line they never saw. */
    const lines = [debit(REAL_SALARY, 150000), debit("NEFT-UNKNOWN VENDOR", 900)];
    const out = suggestBatch(lines, RULES, suggestCategory);
    expect(out).toHaveLength(2);
    expect(out[0].suggestion?.category).toBe("Salaries");
    expect(out[1].suggestion).toBeNull();
  });
});
