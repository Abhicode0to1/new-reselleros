import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findBillingTerm } from "@/lib/inbound/extract";

/* ─────────────────────────────────────────────────────────────────────────────
   30 Aug 2026. App ne poochha "monthly ya annual?" — kyunki quote annual maan kar bana tha
   aur isiliye bheja nahi gaya tha. Customer ne likha **"monthly"**. Jo reply gayi usme
   likha tha "Rs 325 per seat per MONTH" — aur uske saath juda document,
   Q-ADPL-2026-27-0045, **Rs 1,11,255 SAALANA** ka tha.

   Shabd aur document alag baat keh rahe the. Aur document wahi hissa hai jo customer
   sambhal kar rakhta hai.

   Wajah `quote-dispatcher.ts` me ek line thi:

     term: "annual",     // hardcoded

   Uska comment galat nahi tha — wo kehta tha ki agent ko dikhaye gaye saare daam annual
   commitment ke hain. Bas wo ek surat chhod deta tha: jab customer KHUD term bataye.
   ───────────────────────────────────────────────────────────────────────────── */

const SRC = join(process.cwd(), "src", "lib", "ai");
const nocomment = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

const DISPATCHER = nocomment(readFileSync(join(SRC, "actions", "quote-dispatcher.ts"), "utf8"));
const RUNNER = nocomment(readFileSync(join(SRC, "run-sales-agent.ts"), "utf8"));

describe("hardcoded term wapas nahi aana chahiye", () => {
  it("dispatcher me `term: \"annual\"` ab likha hua nahi hai", () => {
    /* Ye wahi line hai jisne asli quote galat bana diya. Wapas aayi to ye laal hoga. */
    expect(DISPATCHER).not.toMatch(/term:\s*"annual"\s*,/);
  });

  it("dispatcher customer ki batayi term leta hai, aur na ho to annual", () => {
    expect(DISPATCHER).toMatch(/term:\s*args\.term\s*\?\?\s*"annual"/);
    expect(DISPATCHER).toMatch(/termSource:\s*args\.termSource\s*\?\?/);
  });

  it("caller wahi function use karta hai jo inbound path karta hai", () => {
    /* Doosri keyword-list banane ka matlab hota do jagah "monthly" ka alag matlab — aaj
       barabar, kal nahi. */
    expect(RUNNER).toMatch(/findBillingTerm\(args\.incoming\)/);
    expect(RUNNER).toContain("@/lib/inbound/extract");
  });
});

describe("findBillingTerm — wahi jo asli mail me tha", () => {
  it("akela \"monthly\" pakda jata hai", () => {
    /* Pardeep ka poora sandesh yahi ek shabd tha. */
    expect(findBillingTerm("monthly").value).toBe("monthly");
  });

  it("aam likhawat ke roop", () => {
    for (const [text, want] of [
      ["monthly billing please", "monthly"],
      ["per month bill kar dijiye", "monthly"],
      ["mahina wala plan", "monthly"],
      ["annual billing", "annual"],
      ["yearly plan chahiye", "annual"],
      ["for 1 year ka quote", "annual"],
      ["saalana rate batao", "annual"],
    ] as const) {
      expect(findBillingTerm(text).value, text).toBe(want);
    }
  });

  it("⚠️ akela \"1 year\" (bina 'for') NAHI pakda jata — ye ek asli kami hai", () => {
    /* Meri pehli expectation yahan galat thi, code nahi. `ANNUAL_RE` me `for 1 year` hai,
       akela `1 year` nahi — aur wo sankeernta jaan-boojhkar hai: bare "year" "is saal",
       "last year", "year-end" jaise vaakyon par galat lag jata.

       Par "1 year ka quote bhejiye" bilkul aam likhawat hai. Ise jaan-boojhkar YAHAN darj
       kiya gaya hai bajaye chup-chaap regex chauda karne ke — wo regex inbound path par
       bhi lagti hai aur paise ke faisle par baithti hai, isliye use ek test likhte waqt
       side-effect ki tarah nahi badalna chahiye.

       Ye test us din laal hoga jis din koi ise theek karega — aur tab wo jaan-boojhkar
       liya gaya faisla hoga, ittefaq nahi. */
    expect(findBillingTerm("1 year ka quote bhejiye").value).toBeNull();
  });

  it("na kahi ho to NULL — aur tab annual hi rahega", () => {
    /* Yahi purana vyavhaar hai aur wahi bacha hua hai. Badla sirf itna hai ki saaf
       "monthly" ab document tak pahunchta hai. */
    expect(findBillingTerm("mujhe 30 email id ke quote chahiye").value).toBeNull();
  });

  it("dono kahe hon to null — do me se andaza nahi lagata", () => {
    expect(findBillingTerm("monthly ya annual, dono ka rate bhejiye").value).toBeNull();
  });

  it("\"12 months\" annual hai — mahine me likha hua saal", () => {
    expect(findBillingTerm("12 months ka commitment").value).toBe("annual");
  });
});
