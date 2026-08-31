import { describe, it, expect } from "vitest";
import { quoteEmailBody, cycleUnitSuffix, indianDate } from "./quote-body";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

/* ─────────────────────────────────────────────────────────────────────────────
   31 Aug 2026 — Q-ADPL-2026-27-0068 jaisa customer ke paas pahuncha:

     QUOTE Q-ADPL-2026-27-0068
       25 × Google Workspace Business Starter — ₹8,125
       Subtotal ₹8,125 · GST 18% ₹1,463 · TOTAL ₹9,588
     Valid until 2026-09-07.

   Pardeep ne ek line me bata diya: "monthly quotation hai" — aur *monthly* shabd kahin tha
   hi nahi. ₹8,125 padhne me ek-baar ka lagta hai, ya saal ka. Usi mail ke saath laga PDF keh
   raha tha "Rs 325/seat/mo · Commitment — None, cancel any month".

   Yaani document aur uski covering letter ek hi paise ko do tarah bata rahe the — theek wahi
   shakl jo is project ko do baar mehngi padi hai (maasik daam 12 se baanta gaya, aur flex par
   ek saal chhapa jo kisi ne maana nahi tha).
   ───────────────────────────────────────────────────────────────────────────── */

const FLEX: QuoteLineItem[] = [
  { name: "Google Workspace Business Starter", qty: 25, rate: 325, cost: 300, commitment: "monthly" },
] as unknown as QuoteLineItem[];

const ANNUAL: QuoteLineItem[] = [
  { name: "Google Workspace Business Starter", qty: 25, rate: 3240, cost: 3000, commitment: "annual_yearly" },
] as unknown as QuoteLineItem[];

const base = {
  quoteId: "Q-ADPL-2026-27-0068",
  customerName: "Sri Ganga Technologies",
  sellerName: "ANUTECH DIGITAL PVT LTD",
  discountPct: 0,
  discount: 0,
  taxRate: 18,
  expiresDate: "2026-09-07",
  migrationOffer: "Your existing mail and data are migrated at no extra charge.",
};

const monthly = quoteEmailBody({
  ...base, lineItems: FLEX, billingCycle: "monthly",
  subtotal: 8_125, tax: 1_463, total: 9_588,
});

const annual = quoteEmailBody({
  ...base, lineItems: ANNUAL, billingCycle: "yearly",
  subtotal: 81_000, tax: 14_580, total: 95_580,
});

describe("maasik quotation par MAASIK likha hota hai", () => {
  it("ASLI MAAMLA — har aankde ke saath /month", () => {
    /* Wahi kami thi. Ek bhi jagah ikai chhoot jaye to padhne wala andaza lagayega. */
    expect(monthly).toContain("₹8,125/month");
    expect(monthly).toContain("₹1,463/month");
    expect(monthly).toContain("₹9,588/month");
  });

  it("kul jod ka LABEL bhi batata hai ki ye har mahine dena hai", () => {
    expect(monthly).toContain("PAYABLE EACH MONTH");
    expect(monthly).not.toContain("TOTAL ");
  });

  it("per-seat rate apni ikai ke saath — yahi aankda grahak jaanchta hai", () => {
    expect(monthly).toContain("₹325 per seat per month");
  });

  it("commitment apni line par, aur wo BECHNE wali baat hai", () => {
    expect(monthly).toContain("None — billed monthly, cancel or change seats any month");
  });
});

describe("saalana par saalana", () => {
  it("koi /month nahi, aur rate per SAAL", () => {
    /* Flex ka rate per seat per MAHINA hai, annual ka per SAAL. Dono ko ek jaisa likhna wahi
       12x ki galti hai, covering letter me. */
    expect(annual).toContain("₹3,240 per seat per year");
    expect(annual).not.toContain("/month");
    expect(annual).toContain("TOTAL");
    expect(annual).toContain("Commitment      Annual, billed yearly");
  });
});

describe("discount tabhi jab ho", () => {
  it("0% par discount ki line hi nahi", () => {
    /* Flex par discount lagta hi nahi (Pardeep ka niyam), to "Discount 0%" likhna sirf
       sawaal paida karta. */
    expect(monthly).not.toContain("Discount");
  });

  it("hone par ikai ke saath", () => {
    const withDisc = quoteEmailBody({
      ...base, lineItems: ANNUAL, billingCycle: "yearly",
      discountPct: 3, discount: 2_430, subtotal: 81_000, tax: 14_143, total: 92_713,
    });
    expect(withDisc).toContain("Discount 3%");
    expect(withDisc).toContain("₹2,430");
  });
});

describe("date Indian format me", () => {
  it("ASLI MAAMLA — 2026-09-07 nahi, 07 Sep 2026", () => {
    /* App ka apna format — "7 Sept 2026". Maine pehle apna alag formatter likha tha jo "07
       Sep" deta tha; koi doosri screen aisa nahi dikhati. Ek app, ek date format. */
    expect(monthly).toContain("7 Sept 2026");
    expect(monthly).not.toContain("2026-09-07");
  });

  it("khaali ya galat date par wo line hi nahi aati", () => {
    const noDate = quoteEmailBody({
      ...base, expiresDate: null, lineItems: FLEX, billingCycle: "monthly",
      subtotal: 8_125, tax: 1_463, total: 9_588,
    });
    expect(noDate).not.toContain("valid until");
    expect(indianDate("kuch bhi nahi")).toBeNull();
  });
});

describe("vaada template ka nahi, tenant ka hota hai", () => {
  it("migrationOffer na do to wo line hi nahi", () => {
    /* "Free migration" ek COMMERCIAL vaada hai. Ye repo model ko aisa vaada gadhne nahi deta,
       to template ko bhi nahi dena chahiye — doosre reseller ka offer alag ho sakta hai. */
    const bare = quoteEmailBody({
      ...base, migrationOffer: null, lineItems: FLEX, billingCycle: "monthly",
      subtotal: 8_125, tax: 1_463, total: 9_588,
    });
    expect(bare).not.toContain("no extra charge");
    expect(bare).toContain("we provision the accounts.");
  });
});

describe("ikai ka naksha", () => {
  it("chaaron cycle", () => {
    expect(cycleUnitSuffix("monthly")).toBe("/month");
    expect(cycleUnitSuffix("quarterly")).toBe("/quarter");
    expect(cycleUnitSuffix("half_yearly")).toBe("/half-year");
    expect(cycleUnitSuffix("yearly")).toBe("");
  });
});

describe("grahak ka naam na ho", () => {
  it("khaali naam par bhi letter theek rehta hai", () => {
    const anon = quoteEmailBody({
      ...base, customerName: "   ", lineItems: FLEX, billingCycle: "monthly",
      subtotal: 8_125, tax: 1_463, total: 9_588,
    });
    expect(anon).toContain("Dear Sir/Madam,");
  });
});
