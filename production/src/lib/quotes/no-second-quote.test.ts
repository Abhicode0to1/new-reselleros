import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────────
   EK MAANG, EK DOCUMENT — Pardeep ne 31 Aug 2026, 15:25 par pakda.

   Lead L-MTH28OTO ko DO bilkul ek jaise quotation gaye: Q-0064 aur Q-0066, dono
   10 × Business Starter, Rs 3,250/mahina, dono email ho gaye, chheh second ke faasle par.

     09:53:08  pehli mail   -> Q-0064 draft, term ANDAZA annual, theek se nahi bheja
     09:55:05  reply "monthly"
     09:55:08  Q-0064 RE-PRICED — inbound pipeline (usi subah ka mera badlav)
     09:55:15  Q-0064 email
     09:55:21  Q-0066 — AI AGENT ke dispatcher ne banaya
     09:55:25  Q-0066 bhi email

   `autoQuoteForLead` ke DO caller hain — inbound pipeline aur AI agent — aur dono aise likhe
   gaye the jaise wahi akele hon. Wo takraaye nahi kyunki reply par (wahi seats, wahi plan)
   `shouldRequoteOnReply` "kuch nahi badla" kehta tha aur pipeline chup rehti thi. Term par
   re-price sikhane se pipeline jaag gayi, aur dono chal gaye.

   Keemat: Rule 46 ki gapless series se DO number, aur customer ke inbox me DO PDF, ek hi
   maang ke liye.

   Isliye sawaal ANDAR aa gaya. Caller se ye poochhna bharosa maangta hai, aur ek caller ne
   kabhi poochha hi nahi.
   ───────────────────────────────────────────────────────────────────────────── */

const runnable = (parts: string[]): string =>
  readFileSync(join(process.cwd(), "src", ...parts), "utf8")
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\s\/\/.*$/, ""))
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

const AUTO_QUOTE = ["lib", "quotes", "auto-quote-for-lead.ts"];

describe("dobara wahi quote nahi banta", () => {
  it("autoQuoteForLead KHUD dekhta hai ki ye maang pehle se quote ho chuki hai", () => {
    const code = runnable(AUTO_QUOTE);
    /* Number allocate karne se PEHLE. Baad me dekhna number kharch kar dene ke baad dekhna
       hai, aur wo wapas nahi milta. */
    const at = code.indexOf('.from("quotes")');
    const allocAt = code.indexOf("next_document_number");
    expect(at, "maujooda quote ka lookup hi nahi hai").toBeGreaterThan(-1);
    expect(at, "lookup number allocate karne ke BAAD hai — tab tak number kharch ho chuka")
      .toBeLessThan(allocAt);
  });

  it("teeno cheez milani padti hain — seats, plan, billing cycle", () => {
    /* Ek bhi badle to wo NAYA document hai, aur banna chahiye. Sirf seats dekhna ek badle
       hue product par duplicate rok deta. */
    const code = runnable(AUTO_QUOTE);
    expect(code).toMatch(/already\.seats === args\.seats/);
    expect(code).toMatch(/already\.plan .*=== .*args\.item\?\.name/);
    expect(code).toMatch(/already\.billing_cycle .*=== wantCycle/);
  });

  it("BHEJE hue par ruka jata hai, DRAFT par nahi", () => {
    /* Draft theek kiya ja sakta hai — wahi `repriceDraftId` karta hai. Bheja hua document
       dobara nahi banta. */
    const code = runnable(AUTO_QUOTE);
    expect(code).toMatch(/already\.status !== "draft"/);
  });

  it("rukne par timeline par WAJAH likhi jati hai", () => {
    /* Chup-chaap kuch na karna hi wo cheez hai jisse aaj din bhar dikkat hui. */
    const code = runnable(AUTO_QUOTE);
    expect(code).toContain("No second quotation raised");
  });
});

describe("dono caller isi ek function se guzarte hain", () => {
  it("inbound pipeline aur AI agent — dono", () => {
    /* Agar koi teesra caller aaya, wo bhi is guard ke peeche hoga: guard function ke ANDAR
       hai, caller ke paas nahi. Ye test us baat ko darj karta hai. */
    expect(runnable(["lib", "inbound", "ingest.ts"])).toContain("autoQuoteForLead(admin, {");
    expect(runnable(["lib", "ai", "actions", "quote-dispatcher.ts"]))
      .toContain("autoQuoteForLead(args.admin, {");
  });

  it("koi caller khud quote row insert nahi karta", () => {
    /* Ek doosra insert us guard ko bypass kar dega. `next_document_number` bhi sirf yahan. */
    for (const f of [["lib", "inbound", "ingest.ts"],
                     ["lib", "ai", "actions", "quote-dispatcher.ts"]]) {
      const code = runnable(f);
      expect(code, f.join("/")).not.toMatch(/from\("quotes"\)\s*\.insert/);
      expect(code, f.join("/")).not.toContain('p_doc_type: "quote"');
    }
  });
});
