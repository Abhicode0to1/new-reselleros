import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planQuoteFromEnquiry } from "./quote-from-enquiry";

/* ─────────────────────────────────────────────────────────────────────────────
   Q-ADPL-2026-27-0049 — 45 seats, monthly — ek asli customer ko bheja gaya, aur usme
   daam BAARAH GUNA KAM tha.

     line       45 x Rs 325/seat/MAHINA   →  subtotal Rs 14,625   (bilkul sahi, maasik)
     row        billing_cycle "yearly"
     PDF        Rs 27/seat/mo · Rs 1,219/mo · "Annual contract value Rs 16,739"

   Asli saalana keemat: Rs 1,75,500.

   Planner ka koi dosh nahi tha — usne 325/seat/MAHINA hi lagaya. Galti ye thi ki
   `auto-quote-for-lead.ts` ka insert `billing_cycle` naam bhi nahi leta tha, to har
   auto-quote column ke default `yearly` par chala jata tha. `QuotePDF` me:

     billingCycle ?? cycleFromLegacyCommitment(firstCommitment)

   — yaani ROW, LINE ko harata hai. Document par shabd "Monthly (flex), billed monthly"
   likhe the aur ganit saalana ka tha. Dono aapas me ulte.

   Jab tak sab kuch annual quote hota tha, ye chhupa raha. Jis din maasik quote ban-na
   shuru hua, usi din ye ek GST document par 12x ki galti ban gaya.
   ───────────────────────────────────────────────────────────────────────────── */

const ITEM = {
  id: "i1",
  name: "Google Workspace Business Starter",
  /* Live catalogue, 30 Aug 2026: Rs/seat/MONTH. */
  msrp: 270,
  wholesale: 250,
  prices: { monthly: { msrp: 325, wholesale: 300 } },
} as Parameters<typeof planQuoteFromEnquiry>[0]["item"];

/**
 * `EnquiryQuotePlan` ek union hai — `{ok:false, reason}` ya `{ok:true, items, subtotal…}`.
 *
 * Ye helper `ok` par narrow karta hai AUR use assert bhi karta hai. Wo assert bekaar nahi:
 * planner paanch alag wajahon se mana kar sakta hai, aur `ok:false` par neeche ka har
 * expectation chup-chaap chhoot jata — ek test jo kuch jaanchta hi nahi, hara dikhta rehta.
 */
function priced(seats: number, term: "monthly" | "annual") {
  const p = planQuoteFromEnquiry({ item: ITEM, seats, term });
  expect(p.ok, p.ok ? "" : `planner ne mana kiya: ${p.reason}`).toBe(true);
  if (!p.ok) throw new Error(p.reason);
  return p;
}

describe("maasik line par daam MAHINE ka hota hai", () => {
  it("45 seats monthly → subtotal 14,625 (45 x 325), saalana nahi", () => {
    const p = priced(45, "monthly");
    expect(p.subtotal).toBe(14_625);
    expect(p.items[0].rate).toBe(325);
    expect(p.items[0].commitment).toBe("monthly");
  });

  it("wahi 45 seats annual par barah guna zyada", () => {
    const p = priced(45, "annual");
    expect(p.items[0].rate).toBe(270 * 12);
    expect(p.subtotal).toBe(45 * 270 * 12);
    expect(p.items[0].commitment).toBe("annual_yearly");
  });

  it("dono ka antar theek 12 ka nahi hota — flex tier apna daam hai", () => {
    /* 325 vs 270: bina commitment wale tier ka daam zyada hai, aur yahi do tier rakhne ka
       matlab hai. Isliye "monthly = annual / 12" wali koi bhi jaanch galat hogi. */
    const m = priced(45, "monthly");
    const a = priced(45, "annual");
    expect(a.subtotal / 12).not.toBe(m.subtotal);
    expect(m.subtotal).toBeGreaterThan(a.subtotal / 12);
  });
});

describe("row ka billing_cycle line se mel khata hai — yahi 12x rokta hai", () => {
  const SRC = readFileSync(
    join(process.cwd(), "src", "lib", "quotes", "auto-quote-for-lead.ts"), "utf8");
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  it("insert billing_cycle naam se likhta hai — chhod nahi deta", () => {
    /* Ye chhoot jana hi poori galti thi: naam na lene se column ka default `yearly` lag
       jata tha, chahe line maasik ho. */
    expect(code).toMatch(/billing_cycle:/);
  });

  it("wo line ki apni commitment se aata hai, customer ke shabdon se dobara nahi", () => {
    /* Planner ne jo daam LAGAYA, wahi ek sach hai. Customer ka mail dobara padhna do
       jagah do jawab paida karta — aur unme se ek document par chhap jata. */
    expect(code).toMatch(/plan\.items\[0\]\?\.commitment === "monthly"/);
  });

  it("PDF row ko line se upar rakhta hai — isiliye row ka sahi hona zaroori hai", () => {
    const pdf = readFileSync(join(process.cwd(), "src", "lib", "pdf", "QuotePDF.tsx"), "utf8");
    expect(pdf).toMatch(/billingCycle \?\? cycleFromLegacyCommitment/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   FLEX PAR KOI VOLUME DISCOUNT NAHI — Pardeep, 31 Aug 2026:
   "monthly committment par koi discount nahi hai."

   Do tier rakhne ka matlab hi yahi hai. Flex ka daam PEHLE SE zyada hai — Rs 325 vs Rs 270 —
   theek isliye ki customer koi vaada nahi kar raha. Uspar volume discount dena wahi premium
   kharch kar deta hai jiske liye tier bana hai, ek aise bandhan ke badle jo kisi ne kiya hi
   nahi.

   Naapa gaya us mail par jisse ye nikla: Q-ADPL-2026-27-0057, 37 seats, monthly ke daam par
   3% discount ke saath BHEJ diya gaya. AI ka apna jawab sahi tha — usne 3% saalana line par
   dikhaya aur monthly par plain Rs 325 — kyunki `netCostBlock` sirf `msrpPerSeatPerYear` par
   discount lagata hai. Yaani model aur pricer ek hi lead par alag baat kar rahe the, aur
   document pricer likh raha tha.
   ───────────────────────────────────────────────────────────────────────────── */
describe("flex par volume discount nahi lagta", () => {
  it("37 seats monthly — 3% wale band me hai, phir bhi 0%", () => {
    /* 37 seats saalana par 3% kamata hai (neeche wala test wahi saabit karta hai), to ye
       "band me nahi tha" wali surat nahi hai — ye tier ka faisla hai. */
    const p = priced(37, "monthly");
    expect(p.discountPct).toBe(0);
    expect(p.subtotal).toBe(37 * 325);
    /* GST 18%, bina discount ke. */
    expect(p.amount).toBe(Math.round(37 * 325 * 1.18));
  });

  it("wahi 37 seats ANNUAL par discount kamata hai", () => {
    /* Control. Iske bina upar wala test "shayad 37 seats ka koi band hi nahi hai" ho sakta
       tha, aur kuch bhi saabit na karta. */
    const p = priced(37, "annual");
    expect(p.discountPct).toBeGreaterThan(0);
  });

  it("draft par WAJAH likhi hoti hai, sirf 'no discount' nahi", () => {
    /* Customer poochhega ki 37 seats par kuch kam kyun nahi hua, aur jawab document par hona
       chahiye. `toBeTruthy()` se ye jaanch shuru hui thi — wo har haal me pass hoti, kyunki
       do string jodne par kuch to banta hi hai. Ye wala asli shabd dhoondhta hai. */
    const p = priced(37, "monthly");
    expect(p.assumption).toContain("no volume discount");
    expect(p.assumption).toContain("no-commitment premium");
    /* Aur SAALANA daam is note me nahi aana chahiye. Pehli koshish me maine "Rs 325 against
       Rs 270" likha tha aur quote-from-enquiry.test.ts laal ho gaya — theek hua. Us file ka
       niyam hai: assumption wahi rate le jo LINE par hai. Aur `270` ka wahan hona khud ek
       ishara hai — matlab monthly tier mila hi nahi aur saalana rate lag gaya. Use samjhane
       ke liye likh dena us ishare ko hi mita deta. */
    expect(p.assumption).not.toContain("270");
  });

  it("aur ANNUAL draft par wo wajah NAHI likhi hoti", () => {
    /* Warna ye jaanch us line ko pakadti jo har quote par chhapti hai, aur kuch na kehti. */
    expect(priced(37, "annual").assumption).not.toContain("no-commitment premium");
  });
});
