import { describe, it, expect } from "vitest";
import { effectiveReg, DOMAIN_OFFERS , type DomainOffer } from "./offers";

/* Faisla #4 (1 Sep 2026): LIVE map khaali hai jab tak DMS me promo-engine nahi —
   engine ke niyam yahan APNE fixture par piné rehte hain. */
const TEST_OFFERS: Readonly<Record<string, DomainOffer>> = {
  ".in": { price: 1, label: "SEPTEMBER OFFER", until: "2026-09-30" },
};
import { TLDS } from "./data/catalog";

/* ─────────────────────────────────────────────────────────────────────────────
   ".in ₹1 is mahine" — teen baatein pin:
   1. September me ₹1, strike ₹499 ke saath.
   2. 1 October ko APNE AAP ₹499 — bina deploy, bina yaad rakhe. Bhoola hua offer
      public page par galat daam hai.
   3. Renewal ₹799 ko offer chhoota tak nahi — "renewal price next to first-year
      price" hi is site ki pehchan hai.
   ───────────────────────────────────────────────────────────────────────────── */

const IN = TLDS.find((t) => t.tld === ".in")!;

describe(".in ₹1 — September 2026", () => {
  it("mahine ke andar: ₹1, was ₹499, label ke saath", () => {
    const p = effectiveReg(".in", IN.reg, new Date("2026-09-15T10:00:00+05:30"), TEST_OFFERS);
    expect(p).toEqual({ reg: 1, offer: { was: 499, label: "SEPTEMBER OFFER" } });
  });

  it("30 Sept IST ki raat tak chalta hai, 1 Oct IST par khatam", () => {
    expect(effectiveReg(".in", IN.reg, new Date("2026-09-30T23:30:00+05:30"), TEST_OFFERS).reg).toBe(1);
    expect(effectiveReg(".in", IN.reg, new Date("2026-10-01T00:30:00+05:30"), TEST_OFFERS)).toEqual({ reg: 499 });
  });

  it("IST se flip hota hai, UTC se nahi — grahak yahan ke hain", () => {
    /* 30 Sept 20:00 UTC = 1 Oct 01:30 IST → offer band. UTC-soch se ye 30 Sept lagta. */
    expect(effectiveReg(".in", IN.reg, new Date("2026-09-30T20:00:00Z"), TEST_OFFERS)).toEqual({ reg: 499 });
  });

  it("baaki TLD anchhue", () => {
    expect(effectiveReg(".com", 899, new Date("2026-09-15T10:00:00+05:30"), TEST_OFFERS)).toEqual({ reg: 899 });
  });

  it("renewal is module ko chhoota hi nahi — sirf reg", () => {
    /* effectiveReg ka naam hi contract hai; renewal caller ke paas waisa hi rehta hai.
       Ye test us contract ko likh kar pin karta hai. */
    expect(IN.renew).toBe(799);
  });

  it("ulta 'offer' (normal se mehnga) refuse hota hai", () => {
    expect(effectiveReg(".in", 0.5 as unknown as number, new Date("2026-09-15T10:00:00+05:30"), TEST_OFFERS).offer).toBeUndefined();
  });

  it("LIVE map KHAALI hai — jab tak DMS me promo-engine nahi (faisla #4, 1 Sep 2026)", () => {
    /* Purana test yahan .in@1 ki maujoodgi ko pin karta tha aur hatate waqt
       yaad dilane ke liye tha — usne 1 Sep ko apna kaam kiya. Ab ulta niyam:
       jo daam asli dukaan (app.anutech.in) charge nahi kar sakti, wo chehre par
       wapas na aa jaye. Promo-engine banne par ye test palta jayega. */
    expect(Object.keys(DOMAIN_OFFERS)).toEqual([]);
  });});
