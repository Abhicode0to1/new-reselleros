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

describe("maasik line par daam MAHINE ka hota hai", () => {
  it("45 seats monthly → subtotal 14,625 (45 x 325), saalana nahi", () => {
    const p = planQuoteFromEnquiry({ item: ITEM, seats: 45, term: "monthly" });
    expect(p.subtotal).toBe(14_625);
    expect(p.items[0].rate).toBe(325);
    expect(p.items[0].commitment).toBe("monthly");
  });

  it("wahi 45 seats annual par barah guna zyada", () => {
    const p = planQuoteFromEnquiry({ item: ITEM, seats: 45, term: "annual" });
    expect(p.items[0].rate).toBe(270 * 12);
    expect(p.subtotal).toBe(45 * 270 * 12);
    expect(p.items[0].commitment).toBe("annual_yearly");
  });

  it("dono ka antar theek 12 ka nahi hota — flex tier apna daam hai", () => {
    /* 325 vs 270: bina commitment wale tier ka daam zyada hai, aur yahi do tier rakhne ka
       matlab hai. Isliye "monthly = annual / 12" wali koi bhi jaanch galat hogi. */
    const m = planQuoteFromEnquiry({ item: ITEM, seats: 45, term: "monthly" });
    const a = planQuoteFromEnquiry({ item: ITEM, seats: 45, term: "annual" });
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
