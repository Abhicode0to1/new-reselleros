import { describe, it, expect } from "vitest";
import { planQuoteFromEnquiry, type CatalogueItemPrice } from "./quote-from-enquiry";

/* Real numbers from the live catalogue (tenant fbb976f1…, read 23 Aug 2026):
   "Google Workspace Business Starter" msrp 270, wholesale 110 — ₹/seat/MONTH.
   Using the real row matters: as paise those would be ₹2.70 and ₹1.10, which is not a
   price for anything, and that mistake is the one AGENTS.md exists to prevent. */
const STARTER: CatalogueItemPrice = {
  id: "GW-STR-fbb",
  name: "Google Workspace Business Starter",
  msrp: 270,
  wholesale: 110,
};

const id = () => "line-1";

describe("planQuoteFromEnquiry — the arithmetic", () => {
  it("prices 50 seats of Business Starter on an annual term", () => {
    const p = planQuoteFromEnquiry({ item: STARTER, seats: 50, newLineId: id });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    /* ₹270/seat/month × 12 = ₹3,240/seat/year. */
    expect(p.items[0].rate).toBe(3240);
    expect(p.items[0].cost).toBe(1320);
    expect(p.items[0].qty).toBe(50);
    expect(p.items[0].commitment).toBe("annual_yearly");
    /* 50 × 3,240 = ₹1,62,000 ex-GST, BEFORE the volume discount. The line rate stays at list
       and the discount lives at quote level, because every screen renders it as its own
       "Discount (n%)" row off the subtotal — putting it in `rate` as well would give the
       customer the same discount twice. */
    expect(p.subtotal).toBe(162_000);
    /* 50 seats is in the 21–50 band: 3% off. Changed 25 Aug 2026 when the volume rate card
       landed — this expectation used to be ₹1,91,160, which was subtotal × 1.18 with no
       discount at all. */
    expect(p.discountPct).toBe(3);
    /* ₹1,62,000 − 3% (₹4,860) = ₹1,57,140, × 1.18 = ₹1,85,425.2 → ₹1,85,425 incl-GST. */
    expect(p.amount).toBe(185_425);
  });

  it("gives a small deal no discount at all", () => {
    /* The 1–20 band is full list price. A rate card that quietly discounted everything would
       be a price cut, not a volume incentive. */
    const p = planQuoteFromEnquiry({ item: STARTER, seats: 10, newLineId: id });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.discountPct).toBe(0);
    expect(p.amount).toBe(Math.round(p.subtotal * 1.18));
  });

  it("gives 51–100 seats the 5% band, and still prices it in full", () => {
    /* The band that used to produce NOTHING — 51 seats was a flat handover with no quote
       attached. It is priced now; whether it may be SENT is decided separately, by
       decideAutoSend's review band. */
    const p = planQuoteFromEnquiry({ item: STARTER, seats: 60, newLineId: id });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.discountPct).toBe(5);
    expect(p.items[0].rate, "the line stays at list — the discount is at quote level").toBe(3240);
  });

  it("says on the draft's own notes why the price is what it is", () => {
    /* CLAUDE.md §24 and the reason `assumption` states the term: whoever opens this quote
       must READ the discount rather than reverse-engineer it from the total. */
    const p = planQuoteFromEnquiry({ item: STARTER, seats: 30, newLineId: id });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.assumption).toContain("3% off list");
  });

  it("keeps whole rupees — never paise, in or out", () => {
    /* AGENTS.md: money is stored and displayed in whole rupees. A × 100 anywhere in here
       would turn a ₹1.9 lakh quote into a ₹1.9 crore one. */
    const p = planQuoteFromEnquiry({ item: STARTER, seats: 1, newLineId: id });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(Number.isInteger(p.subtotal)).toBe(true);
    expect(Number.isInteger(p.amount)).toBe(true);
    expect(p.subtotal).toBe(3240);
  });

  it("rounds GST once, on the total, not per line", () => {
    /* An odd price is the case that separates the two. 199 × 12 = 2,388; × 7 = 16,716;
       × 1.18 = 19,724.88 → 19,725. Rounding per line would drift. */
    const odd: CatalogueItemPrice = { id: "X", name: "Odd Plan", msrp: 199, wholesale: 90 };
    const p = planQuoteFromEnquiry({ item: odd, seats: 7, newLineId: id });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.subtotal).toBe(16_716);
    expect(p.amount).toBe(19_725);
  });

  it("states the term assumption in words, for the draft's notes", () => {
    /* The mail never says monthly or annual. Whoever opens the draft must read the
       assumption, not deduce it from the rate. */
    const p = planQuoteFromEnquiry({ item: STARTER, seats: 50, newLineId: id });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.assumption).toMatch(/ASSUMED annual/);
    expect(p.assumption).toMatch(/did not say/);
    expect(p.termAssumed).toBe(true);
  });
});

describe("planQuoteFromEnquiry — what it refuses, and whether it says why", () => {
  it("refuses with no product named", () => {
    const p = planQuoteFromEnquiry({ item: null, seats: 50, newLineId: id });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.reason).toMatch(/did not name a product/);
    /* §24: a refusal states the next step, not just the block. */
    expect(p.reason).toMatch(/lead is saved/);
  });

  it("refuses with no seat count — the commonest case, and never guessed", () => {
    /* THE ONE THAT MATTERS. A quote for the wrong number of seats is a bigger error than
       no quote, because it looks finished. */
    const p = planQuoteFromEnquiry({ item: STARTER, seats: null, newLineId: id });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.reason).toMatch(/no seat count/);
    expect(p.reason).toMatch(/Google Workspace Business Starter/);
  });

  it("refuses a hand-priced product instead of quoting zero", () => {
    /* Enterprise and anything custom. The form path skips Enterprise for this reason; a
       zero-rupee quote reaching a customer is worse than none. */
    const ent: CatalogueItemPrice = { id: "E", name: "Google Workspace Enterprise", msrp: null, wholesale: null };
    const p = planQuoteFromEnquiry({ item: ent, seats: 50, newLineId: id });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.reason).toMatch(/no sell price/);
    expect(p.reason).toMatch(/priced by hand/);
  });

  it.each([0, -5, 1.5, 10_000])("refuses seat count %s", (seats) => {
    const p = planQuoteFromEnquiry({ item: STARTER, seats, newLineId: id });
    expect(p.ok).toBe(false);
  });

  it("still quotes when only the cost is missing", () => {
    /* Margin unknown is a reportable state; a missing cost must not block the sell price.
       Cost 0 here means unknown, and it must not be read as 100% margin downstream — which
       is why it is a separate assertion rather than a comment. */
    const noCost: CatalogueItemPrice = { id: "N", name: "No Cost Plan", msrp: 270, wholesale: null };
    const p = planQuoteFromEnquiry({ item: noCost, seats: 10, newLineId: id });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.items[0].cost).toBe(0);
    expect(p.subtotal).toBe(32_400);
  });
});

describe("it agrees with the form path on the same product", () => {
  it("matches buildWorkspaceLines' term and arithmetic", () => {
    /* Two paths quoting the same product on different terms would be worse than either
       choice. buildWorkspaceLines uses rate = monthlyMsrp × 12, commitment annual_yearly,
       amount = round(subtotal × 1.18). Same three here, asserted rather than assumed. */
    const p = planQuoteFromEnquiry({ item: STARTER, seats: 20, newLineId: id });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const expectedSubtotal = 20 * (270 * 12);
    expect(p.subtotal).toBe(expectedSubtotal);
    expect(p.amount).toBe(Math.round(expectedSubtotal * 1.18));
    expect(p.items[0].commitment).toBe("annual_yearly");
  });
});

describe("the term, and whether it was assumed", () => {
  it("prices a MONTHLY term per month, not per year", () => {
    /* The units differ, not just the number — `monthly` carries ₹/seat/MONTH and
       `annual_yearly` carries ₹/seat/YEAR, the boundary commitment-rate.ts polices.
       Writing one as the other is a 12× error on a GST document. */
    const p = planQuoteFromEnquiry({ item: STARTER, seats: 50, term: "monthly", newLineId: id });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.items[0].rate).toBe(270);
    expect(p.items[0].commitment).toBe("monthly");
    expect(p.subtotal).toBe(13_500);
    expect(p.termAssumed).toBe(false);
  });

  it("prices a stated ANNUAL term the same as the assumed one", () => {
    /* Same arithmetic, different provenance. Only `termAssumed` separates them, which is
       exactly what an auto-send gate has to read. */
    const stated  = planQuoteFromEnquiry({ item: STARTER, seats: 50, term: "annual", newLineId: id });
    const assumed = planQuoteFromEnquiry({ item: STARTER, seats: 50, term: null,     newLineId: id });
    expect(stated.ok && assumed.ok).toBe(true);
    if (!stated.ok || !assumed.ok) return;
    expect(stated.subtotal).toBe(assumed.subtotal);
    expect(stated.termAssumed).toBe(false);
    expect(assumed.termAssumed).toBe(true);
  });

  it("says in words which of the two happened", () => {
    const assumed = planQuoteFromEnquiry({ item: STARTER, seats: 50, term: null, newLineId: id });
    const stated  = planQuoteFromEnquiry({ item: STARTER, seats: 50, term: "monthly", newLineId: id });
    expect(assumed.ok && stated.ok).toBe(true);
    if (!assumed.ok || !stated.ok) return;
    expect(assumed.assumption).toMatch(/ASSUMED/);
    expect(stated.assumption).toMatch(/as stated in the mail/);
  });

  it("with NO monthly tier recorded, a monthly quote is a twelfth of the annual one", () => {
    /* Guards the direction of the ×12. A sign or a reciprocal error here quotes 12× or
       1/12 of the deal, and both look plausible on their own.

       ⚠️ NARROWED 26 Aug 2026. This used to be stated unconditionally, and that was only ever
       true because `CatalogueItemPrice` could not see the monthly tier. With one recorded the
       twelfth relationship is WRONG on purpose — the flex tier costs more. `STARTER` has no
       `prices`, so this test now pins the FALLBACK, which is a real path: most of the
       pre-reset catalogue had no price matrix. The tier case is pinned below. */
    const m = planQuoteFromEnquiry({ item: STARTER, seats: 50, term: "monthly", newLineId: id });
    const a = planQuoteFromEnquiry({ item: STARTER, seats: 50, term: "annual",  newLineId: id });
    expect(m.ok && a.ok).toBe(true);
    if (!m.ok || !a.ok) return;
    expect(m.subtotal * 12).toBe(a.subtotal);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   The monthly-flex tier is its own price.

   Found on the live catalogue, 26 Aug 2026: `GWBStarter` carries annual ₹270/seat/month and
   monthly ₹325. Before this, a monthly quote was built at `msrp` — the ANNUAL rate on a
   monthly line, about 17% under. commitment-rate.ts's own header says why that direction is
   the wrong one: "the monthly tier usually costs MORE per month than a twelfth of the annual
   rate". ₹325 confirmed by Pardeep before the code changed; nothing here guesses a price.
   ───────────────────────────────────────────────────────────────────────────── */

describe("the monthly-flex tier", () => {
  /** The live row: annual 270/110, monthly 325/300. */
  const TIERED: CatalogueItemPrice = {
    ...STARTER,
    prices: {
      annual:  { msrp: 270, wholesale: 110 },
      monthly: { msrp: 325, wholesale: 300 },
    },
  };

  it("prices a monthly term at 325, NOT the annual tier's 270", () => {
    const p = planQuoteFromEnquiry({ item: TIERED, seats: 50, term: "monthly", newLineId: id });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.items[0].rate).toBe(325);
    expect(p.items[0].cost).toBe(300);
    expect(p.items[0].commitment).toBe("monthly");
    expect(p.subtotal).toBe(16_250);   // 50 × 325
  });

  it("leaves the ANNUAL term exactly as it was — 270 × 12", () => {
    /* The blast radius matters as much as the fix. Every annual quote ever built came through
       this line, and the monthly tier must not touch it. */
    const tiered = planQuoteFromEnquiry({ item: TIERED, seats: 50, term: "annual", newLineId: id });
    const plain  = planQuoteFromEnquiry({ item: STARTER, seats: 50, term: "annual", newLineId: id });
    expect(tiered.ok && plain.ok).toBe(true);
    if (!tiered.ok || !plain.ok) return;
    expect(tiered.items[0].rate).toBe(3_240);
    expect(tiered.subtotal).toBe(plain.subtotal);
  });

  it("a monthly quote is NOT a twelfth of the annual one — that is the whole point", () => {
    /* The inverse of the fallback test above, and the reason this tier exists: no commitment
       costs more. If these two ever came out as ×12 again, the tier is being ignored. */
    const m = planQuoteFromEnquiry({ item: TIERED, seats: 50, term: "monthly", newLineId: id });
    const a = planQuoteFromEnquiry({ item: TIERED, seats: 50, term: "annual",  newLineId: id });
    expect(m.ok && a.ok).toBe(true);
    if (!m.ok || !a.ok) return;
    expect(m.subtotal * 12).not.toBe(a.subtotal);
    expect(m.subtotal * 12).toBeGreaterThan(a.subtotal);
  });

  it("names the rate it actually used, and admits the fallback when it fell back", () => {
    /* A note that explains the line with a DIFFERENT rate than the line carries is the same
       failure as the email that omitted the volume discount — words the document contradicts. */
    const tiered = planQuoteFromEnquiry({ item: TIERED, seats: 50, term: "monthly", newLineId: id });
    const plain  = planQuoteFromEnquiry({ item: STARTER, seats: 50, term: "monthly", newLineId: id });
    expect(tiered.ok && plain.ok).toBe(true);
    if (!tiered.ok || !plain.ok) return;
    expect(tiered.assumption).toContain("325");
    expect(tiered.assumption).not.toContain("270");
    expect(plain.assumption).toContain("270");
    expect(plain.assumption).toMatch(/no monthly tier recorded/);
  });

  it("ignores a zero or absent monthly tier rather than quoting nothing", () => {
    /* `item-form.tsx` strips a tier whose prices are both 0, but a half-filled matrix reaches
       here from older rows. A 0 must fall back, not become the rate — that would be a free
       quote on a GST document. */
    const zero: CatalogueItemPrice = {
      ...STARTER,
      prices: { monthly: { msrp: 0, wholesale: 0 } },
    };
    const p = planQuoteFromEnquiry({ item: zero, seats: 50, term: "monthly", newLineId: id });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.items[0].rate).toBe(270);
  });
});
