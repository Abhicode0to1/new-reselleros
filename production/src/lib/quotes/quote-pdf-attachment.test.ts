import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mentionsQuote } from "./quote-pdf-attachment";

/* ─────────────────────────────────────────────────────────────────────────────
   31 Aug 2026, 16:20 — chitthi ne document ka poora zikr kiya aur usse LAGAYA nahi.

     "We have prepared quotation Q-ADPL-2026-27-0068 for 25 seats of Google Workspace
      Business Starter at Rs 325 per seat per MONTH plus 18% GST, totaling Rs 8,125 plus
      18% GST per month.
      Confirm quotation Q-ADPL-2026-27-0068 and I will initiate your account setup."

   Kuch attach nahi tha. PDF saat minute pehle ek alag mail me chala gaya tha — yaani document
   maujood tha — par JIS chitthi ko customer padh raha hai, usme attachment dhoondhega aur
   nahi milega, aur use apne inbox me ek purani mail khojni padegi.

   Niyam: **jo chitthi document ka naam leti hai, wo document saath le kar jati hai.** "Kabhi
   bhej diya gaya tha" hamare outbox ka tathya hai, customer ki screen ka nahi.
   ───────────────────────────────────────────────────────────────────────────── */

const REAL_BODY =
  "Thank you for confirming monthly billing.\n\n" +
  "We have prepared quotation Q-ADPL-2026-27-0068 for 25 seats of Google Workspace " +
  "Business Starter at Rs 325 per seat per MONTH plus 18% GST.\n\n" +
  "Confirm quotation Q-ADPL-2026-27-0068 and I will initiate your account setup.";

describe("kaunsi chitthi PDF le kar jaye", () => {
  it("ASLI MAAMLA — chitthi quote ka naam leti hai to haan", () => {
    expect(mentionsQuote(REAL_BODY, "Q-ADPL-2026-27-0068")).toBe(true);
  });

  it("'noted, thanks' jaisi chitthi PDF nahi kheenchti", () => {
    /* Trigger MATN hai, document ka hona nahi. Warna baat-cheet ke har jawab ke saath ek PDF
       jata rehta, aur wo apne aap me pareshani hai. */
    expect(mentionsQuote("Noted, thank you. We will confirm shortly.", "Q-ADPL-2026-27-0068"))
      .toBe(false);
  });

  it("koi delivered quote hi na ho to kuch nahi", () => {
    /* Draft ka na number batao, na PDF bhejo — lib/quotes/quote-delivered.ts. */
    expect(mentionsQuote(REAL_BODY, null)).toBe(false);
    expect(mentionsQuote(REAL_BODY, undefined)).toBe(false);
  });

  it("doosre quote ka naam ho to bhi nahi", () => {
    expect(mentionsQuote(REAL_BODY, "Q-ADPL-2026-27-0055")).toBe(false);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Aur ek hi jagah PDF banti hai. Ye chalees line `sendAutoQuote` ke andar thi, sirf usi
   raaste se pahunch me. Ab AI ka reply bhi wahi bytes maangta hai, aur nakal karne ka matlab
   hota do jagah ek hi money document render karna — theek wahi shakl jo aaj din bhar
   mehngi padi.
   ───────────────────────────────────────────────────────────────────────────── */
describe("PDF banane ki ek hi jagah", () => {
  const runnable = (parts: string[]): string =>
    readFileSync(join(process.cwd(), "src", ...parts), "utf8")
      .replace(/\r\n?/g, "\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\s\/\/.*$/, ""))
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");

  it("AI ka reply attachment isi helper se leta hai", () => {
    const code = runnable(["lib", "ai", "actions", "quote-dispatcher.ts"]);
    expect(code).toContain("quotePdfAttachment(args.admin, args.tenantId");
    expect(code).toContain("mentionsQuote(decision.generated_response.body_text");
  });

  it("aur wo id DELIVERED wali hai, koi bhi nahi", () => {
    /* Bina iske ek bina-bheje draft ka PDF chala jata — aur uska number batane par hi aaj
       subah rok lagayi thi. */
    const code = runnable(["lib", "ai", "run-sales-agent.ts"]);
    expect(code).toMatch(/deliveredQuoteId:\s*quote\.deliveredId/);
  });

  it("reply path apna alag renderQuotePDF nahi bulata", () => {
    /* Do jagah render karna = ek hi document ke do daam ho jane ka raasta. */
    const code = runnable(["lib", "ai", "actions", "quote-dispatcher.ts"]);
    expect(code).not.toContain("renderQuotePDF(");
  });
});
