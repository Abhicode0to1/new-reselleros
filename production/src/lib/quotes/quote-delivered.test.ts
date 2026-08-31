import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quoteWasDelivered, DELIVERED_QUOTE_STATUSES } from "./quote-delivered";

/* ─────────────────────────────────────────────────────────────────────────────
   31 Aug 2026. Q-ADPL-2026-27-0055 andaze ke annual term par draft hua aur theek hi nahi
   bheja gaya. Phir agent ne customer ko likha:

     "Quotation Q-ADPL-2026-27-0055 has been prepared for 32 seats..."

   Yaani customer ke paas ek document ka number aa gaya jo usne dekha hi nahi, aur jiska daam
   app ne batane se mana kar diya tha. `unbackedQuoteClaim` apne likhe mutabik theek chal raha
   tha — wo quote MAUJOOD hone par daawe ko sahi maanta hai, aur quote maujood tha. Galti us
   TATHYA me thi jo use diya gaya.

   Pardeep ka faisla: number tabhi bataya jaye jab document BHEJ diya gaya ho.
   ───────────────────────────────────────────────────────────────────────────── */

describe("draft ka matlab hai customer ke paas nahi hai", () => {
  it("draft par jhooth — YAHI ASLI MAAMLA HAI", () => {
    expect(quoteWasDelivered("draft")).toBe(false);
  });

  it("sent, accepted, rejected — teeno ka matlab hai usne dekha hai", () => {
    /* accepted aur rejected ka matlab to usne dekh kar KUCH KIYA bhi hai. */
    for (const s of ["sent", "accepted", "rejected"]) {
      expect(quoteWasDelivered(s), s).toBe(true);
    }
  });

  it("null, khaali, anjaan status — sab par 'nahi'", () => {
    /* Dono galtiyon ki keemat barabar nahi hai: ek asli quotation par chup rehna sirf ek
       patla email hai; na-bheje quotation ka number batana wo galti hai jiske liye ye file
       likhi gayi. */
    for (const s of [null, undefined, "", "   ", "expired", "superseded", "kuch_bhi"]) {
      expect(quoteWasDelivered(s), String(s)).toBe(false);
    }
  });

  it("bade-chhote akshar aur spaces se farq nahi padta", () => {
    expect(quoteWasDelivered(" SENT ")).toBe(true);
    expect(quoteWasDelivered("Accepted")).toBe(true);
  });

  it("list me 'draft' bhool kar bhi nahi hona chahiye", () => {
    expect(DELIVERED_QUOTE_STATUSES).not.toContain("draft");
  });
});

describe("guard ko DELIVERED id milti hai, koi bhi nahi", () => {
  const strip = (f: string[]): string =>
    readFileSync(join(process.cwd(), "src", ...f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  it("quoteRef deliveredQuoteId se aata hai", () => {
    /* `unbackedQuoteClaim` ek non-null ref ko "daawa sach hai" maanta hai. Isliye usme jo
       jata hai, wahi poora niyam hai. */
    const code = strip(["lib", "ai", "sales-agent.server.ts"]);
    expect(code).toMatch(/quoteRef:\s*args\.lead\.deliveredQuoteId/);
    expect(code, "existingQuoteId dobara aa gaya — draft phir number bata dega")
      .not.toMatch(/quoteRef:\s*args\.lead\.existingQuoteId/);
  });

  it("prompt draft par saaf mana karta hai", () => {
    const code = strip(["lib", "ai", "sales-agent.ts"]);
    expect(code).toMatch(/has been SENT to this customer/);
    expect(code).toMatch(/NOT been given a reference number/);
  });
});
