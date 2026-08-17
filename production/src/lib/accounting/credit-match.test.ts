import { describe, it, expect } from "vitest";
import {
  matchCreditToQuotes, narrationNames, customerNameTokens, nameOverlap, canAutoApply,
  AMOUNT_TOLERANCE, MAX_DAYS_BEFORE,
  type QuoteCandidate, type CreditToMatch,
} from "./credit-match";

/**
 * Narrations copied VERBATIM from ANUTECH's live bank_transactions — the nine unmatched
 * credits worth ₹4.6 lakh that motivated this module. Synthetic strings would have been
 * cleaner and would not have caught that a UTR sits between "IMPS" and the payer's name,
 * or that masked digits arrive as "XXXXXXX10".
 */
const LIVE = {
  upiMukul:    "UPI-MUKUL BHARDWAJ-9896033878-2@AXL-BARB",
  impsDarshan: "IMPS-519009330625-DARSHAN KUMAR-HDFC-XXX",
  loanJulie:   "50100691932684-TPT-LOAN GIVEN-JULIE RAWA",
  ownAccount:  "CU1906914097ANUTECH DIGITAL PVT LTD",
  apiBanking:  "IMPS-602897187130-API BANKING EB-NESF-XX",
  neetu:       "IMPS-518916843797-NEETU  -SBIN-XXXXXXX10",
};

describe("pulling a payer's name out of a bank narration", () => {
  it("finds the name in a UPI line, past the rail and the VPA", () => {
    expect(narrationNames(LIVE.upiMukul)).toContain("mukul");
    expect(narrationNames(LIVE.upiMukul)).toContain("bhardwaj");
  });

  it("finds it in an IMPS line, past the 12-digit UTR", () => {
    const n = narrationNames(LIVE.impsDarshan);
    expect(n).toContain("darshan");
    expect(n).toContain("kumar");
  });

  it("drops the rail, the bank codes and the masked digits", () => {
    const n = narrationNames(LIVE.impsDarshan);
    for (const noise of ["imps", "hdfc", "xxx"]) expect(n).not.toContain(noise);
    expect(narrationNames(LIVE.upiMukul)).not.toContain("axl");
    expect(narrationNames(LIVE.upiMukul)).not.toContain("barb");
    expect(narrationNames(LIVE.neetu)).not.toContain("sbin");
  });

  it("drops words that describe the TRANSACTION rather than the payer", () => {
    /* "LOAN GIVEN" is what the money was, not who sent it. Left in, "given" would match
       any customer with that word anywhere in their name. */
    const n = narrationNames(LIVE.loanJulie);
    expect(n).toContain("julie");
    expect(n).not.toContain("loan");
    expect(n).not.toContain("given");
    expect(n).not.toContain("tpt");
  });

  it("survives a narration with no name in it at all", () => {
    /* API BANKING EB is a machine transfer. Returning [] beats inventing a payer. */
    expect(narrationNames(LIVE.apiBanking)).not.toContain("api");
    expect(narrationNames(null)).toEqual([]);
    expect(narrationNames("")).toEqual([]);
  });

  it("ignores company suffixes on the customer side", () => {
    /* "PVT LTD" matching "PVT LTD" is not evidence — every second Indian B2B name has it. */
    const t = customerNameTokens("ANUTECH DIGITAL PVT LTD");
    expect(t).toContain("anutech");
    expect(t).not.toContain("pvt");
    expect(t).not.toContain("ltd");
    expect(t).not.toContain("digital");
  });

  it("ignores the tenant's own misspelt suffix, so 'corprotion' is not a match", () => {
    /* Nine of ANUTECH's own customers are named "<Name> corprotion". Left in, that
       shared typo would match every one of them to every deposit. */
    expect(customerNameTokens("Mary corprotion")).toEqual(["mary"]);
  });
});

describe("nameOverlap — one shared distinctive word, exact", () => {
  it("matches a person paying under their own name", () => {
    expect(nameOverlap(LIVE.impsDarshan, "Darshan Kumar")).toBe("darshan");
  });

  it("matches a company by its distinctive word", () => {
    expect(nameOverlap(LIVE.ownAccount, "Anutech Digital Pvt Ltd")).toBe("anutech");
  });

  it("is NOT fuzzy — one edit apart is a different person", () => {
    /* Levenshtein would call these a match. Neetu and Neeta are two customers, and
       posting a receipt to the wrong one is exactly what this module guards against. */
    expect(nameOverlap(LIVE.neetu, "Neeta Sharma")).toBeNull();
    expect(nameOverlap(LIVE.neetu, "Neetu Sharma")).toBe("neetu");
  });

  it("returns null rather than a weak guess", () => {
    expect(nameOverlap(LIVE.apiBanking, "Mukul Bhardwaj")).toBeNull();
    expect(nameOverlap(null, "Mukul Bhardwaj")).toBeNull();
    expect(nameOverlap(LIVE.upiMukul, null)).toBeNull();
  });
});

const quote = (over: Partial<QuoteCandidate> = {}): QuoteCandidate => ({
  id: "Q-2026-1045", customerName: "Mukul Bhardwaj", amount: 100_000,
  quoteDate: "2025-07-01", ...over,
});
const credit = (over: Partial<CreditToMatch> = {}): CreditToMatch => ({
  amount: 100_000, txnDate: "2025-07-09", description: LIVE.upiMukul, ...over,
});

describe("the name is the strongest signal, not the amount", () => {
  it("calls name + amount CERTAIN", () => {
    const [m] = matchCreditToQuotes(credit(), [quote()]);
    expect(m.confidence).toBe("certain");
    expect(m.matchedName).toBe("mukul");
    expect(m.why).toMatch(/matches to the rupee/);
  });

  it("calls amount-only LIKELY, and says the payer is unnamed", () => {
    /* This is the case everyone builds first and it is the weaker half: two customers on
       the same monthly plan produce identical amounts on the same day. */
    const [m] = matchCreditToQuotes(credit({ description: LIVE.apiBanking }), [quote()]);
    expect(m.confidence).toBe("likely");
    expect(m.why).toMatch(/does not name the payer/);
  });

  it("calls name-only POSSIBLE and names the gap in rupees", () => {
    const [m] = matchCreditToQuotes(credit({ amount: 40_000 }), [quote()]);
    expect(m.confidence).toBe("possible");
    expect(m.amountGap).toBe(60_000);
    expect(m.why).toMatch(/₹60000 away/);
    expect(m.why).toMatch(/part payment/);
  });

  it("ranks certain above likely above possible", () => {
    const got = matchCreditToQuotes(credit(), [
      quote({ id: "Q-possible", customerName: "Mukul Bhardwaj", amount: 250_000 }),
      quote({ id: "Q-likely",   customerName: "Someone Else",   amount: 100_000 }),
      quote({ id: "Q-certain",  customerName: "Mukul Bhardwaj", amount: 100_000 }),
    ]);
    expect(got.map((m) => m.quoteId)).toEqual(["Q-certain", "Q-likely", "Q-possible"]);
  });
});

describe("what is NOT offered as a candidate", () => {
  it("nothing, when neither the name nor the amount is close", () => {
    /* An empty list is a perfectly good answer. Listing every open quote as "possible"
       buries the real one and teaches the operator to click the first row. */
    expect(matchCreditToQuotes(
      credit({ amount: 7_777, description: LIVE.apiBanking }),
      [quote(), quote({ id: "Q-2", customerName: "Other Co", amount: 55_000 })],
    )).toEqual([]);
  });

  it("a quote raised AFTER the money arrived", () => {
    /* Money cannot have paid a quote that did not exist. The window is one-directional
       on purpose, with two days of slack for paperwork that lagged the deposit. */
    expect(matchCreditToQuotes(credit({ txnDate: "2025-07-01" }),
      [quote({ quoteDate: "2025-07-20" })])).toEqual([]);
    expect(matchCreditToQuotes(credit({ txnDate: "2025-07-01" }),
      [quote({ quoteDate: "2025-07-02" })])).toHaveLength(1);
  });

  it("a quote older than the payment-terms window", () => {
    expect(matchCreditToQuotes(credit({ txnDate: "2025-07-09" }),
      [quote({ quoteDate: "2024-01-01" })])).toEqual([]);
    expect(MAX_DAYS_BEFORE).toBe(90);
  });

  it("an amount outside tolerance with no name to carry it", () => {
    const over = matchCreditToQuotes(
      credit({ amount: 100_000 + AMOUNT_TOLERANCE + 1, description: LIVE.apiBanking }), [quote()]);
    expect(over).toEqual([]);
    const within = matchCreditToQuotes(
      credit({ amount: 100_000 + AMOUNT_TOLERANCE, description: LIVE.apiBanking }), [quote()]);
    expect(within).toHaveLength(1);
  });
});

describe("nothing is ever applied without a human", () => {
  it("refuses auto-apply even on a certain match", () => {
    /* A mis-posted receipt is unwound through a credit note and the customer sees it.
       One click by the operator is cheap; one click by the machine is not. This test is
       here so an "auto-reconcile everything certain" feature has to change a reviewed
       line rather than appear inside a UI handler. */
    const [m] = matchCreditToQuotes(credit(), [quote()]);
    expect(m.confidence).toBe("certain");
    expect(canAutoApply(m)).toBe(false);
  });

  it("gives every candidate a reason in words, never a score", () => {
    const all = matchCreditToQuotes(credit(), [
      quote(), quote({ id: "Q-2", customerName: "Other", amount: 100_000 }),
    ]);
    for (const m of all) {
      expect(m.why.length).toBeGreaterThan(30);
      expect(m.why).not.toMatch(/^\d/);
    }
  });
});

describe("the live ₹4.6 lakh, run through the matcher", () => {
  /* The nine real deposits against ANUTECH's eleven accepted quotes. The useful assertion
     is not that it finds matches — it is that it does not INVENT them. */
  const quotes: QuoteCandidate[] = [
    quote({ id: "Q-A", customerName: "Mukul Bhardwaj", amount: 100_000, quoteDate: "2025-07-02" }),
    quote({ id: "Q-B", customerName: "Sunil Sharma",   amount: 11_424,  quoteDate: "2025-07-02" }),
  ];

  it("matches the UPI deposit that names its payer and hits the amount", () => {
    const got = matchCreditToQuotes(
      { amount: 100_000, txnDate: "2025-07-09", description: LIVE.upiMukul }, quotes);
    expect(got[0].quoteId).toBe("Q-A");
    expect(got[0].confidence).toBe("certain");
  });

  it("leaves the ₹1,55,300 'LOAN GIVEN' deposit alone", () => {
    /* It is not a customer payment at all, and no quote is near it. Proposing something
       here would be worse than the deposit staying unmatched. */
    expect(matchCreditToQuotes(
      { amount: 155_300, txnDate: "2025-07-09", description: LIVE.loanJulie }, quotes)).toEqual([]);
  });

  it("leaves the ₹1 API-banking test transfer alone", () => {
    expect(matchCreditToQuotes(
      { amount: 1, txnDate: "2026-01-28", description: LIVE.apiBanking }, quotes)).toEqual([]);
  });

  it("leaves an own-account transfer alone when no quote fits", () => {
    expect(matchCreditToQuotes(
      { amount: 60_000, txnDate: "2025-07-07", description: LIVE.ownAccount }, quotes)).toEqual([]);
  });
});
