import { describe, it, expect } from "vitest";
import { effectiveReg, DOMAIN_OFFERS } from "./offers";
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
    const p = effectiveReg(".in", IN.reg, new Date("2026-09-15T10:00:00+05:30"));
    expect(p).toEqual({ reg: 1, offer: { was: 499, label: "SEPTEMBER OFFER" } });
  });

  it("30 Sept IST ki raat tak chalta hai, 1 Oct IST par khatam", () => {
    expect(effectiveReg(".in", IN.reg, new Date("2026-09-30T23:30:00+05:30")).reg).toBe(1);
    expect(effectiveReg(".in", IN.reg, new Date("2026-10-01T00:30:00+05:30"))).toEqual({ reg: 499 });
  });

  it("IST se flip hota hai, UTC se nahi — grahak yahan ke hain", () => {
    /* 30 Sept 20:00 UTC = 1 Oct 01:30 IST → offer band. UTC-soch se ye 30 Sept lagta. */
    expect(effectiveReg(".in", IN.reg, new Date("2026-09-30T20:00:00Z"))).toEqual({ reg: 499 });
  });

  it("baaki TLD anchhue", () => {
    expect(effectiveReg(".com", 899, new Date("2026-09-15T10:00:00+05:30"))).toEqual({ reg: 899 });
  });

  it("renewal is module ko chhoota hi nahi — sirf reg", () => {
    /* effectiveReg ka naam hi contract hai; renewal caller ke paas waisa hi rehta hai.
       Ye test us contract ko likh kar pin karta hai. */
    expect(IN.renew).toBe(799);
  });

  it("ulta 'offer' (normal se mehnga) refuse hota hai", () => {
    expect(effectiveReg(".in", 0.5 as unknown as number, new Date("2026-09-15T10:00:00+05:30")).offer).toBeUndefined();
  });

  it("offer table me .in maujood hai — ye test offer hatate waqt yaad dilayega", () => {
    expect(DOMAIN_OFFERS[".in"]?.price).toBe(1);
  });
});
