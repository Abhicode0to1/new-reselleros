import { describe, it, expect } from "vitest";
import { lineIsPerInvoice, perInvoiceDivisor, annualContractValue } from "./invoice-divisor";

/* ─────────────────────────────────────────────────────────────────────────────
   Q-ADPL-2026-27-0053, 31 Aug 2026 ko BHEJA gaya. Row ke har khaane me sahi tha:

     36 seats · line rate Rs 325/seat/MAHINA · commitment "monthly"
     billing_cycle "monthly" · subtotal Rs 11,700  (ek mahina)

   PDF ne chhapa: "Rs 27/mo · Rs 975/mo · Annual contract value Rs 13,392".
   Asli daam ka BAARAHVAAN hissa — ek GST document par.

   Wajah: renderer har aankde ko saalana maan kar invoices-per-year se baant raha tha.
   Wo ek surat me sahi hai aur doosri me galat:

     annual_yearly + bill monthly   subtotal ek SAAL hai   → 12 se baanto
     monthly (flex) + bill monthly  subtotal ek MAHINA hai → mat baanto

   `billing_cycle` dono ko alag nahi bata sakta — dono "monthly" kehte hain. LINE ki apni
   commitment bata sakti hai, aur `commitment-rate.ts` isi seemā ko teen SQL test ke saath
   pehle se darj karta hai.
   ───────────────────────────────────────────────────────────────────────────── */

describe("monthly-flex line pehle se ek invoice ki hai", () => {
  it("commitment 'monthly' → per-invoice", () => {
    expect(lineIsPerInvoice("monthly")).toBe(true);
  });

  it("har annual_* → nahi", () => {
    for (const c of ["annual_yearly", "annual_monthly", "annual_quarterly"]) {
      expect(lineIsPerInvoice(c), c).toBe(false);
    }
  });

  it("khaali / null par bhi 'nahi' — purana vyavhaar bachta hai", () => {
    /* Bina commitment wale purane quote annual maane jate the aur waise hi rahenge. */
    expect(lineIsPerInvoice(null)).toBe(false);
    expect(lineIsPerInvoice(undefined)).toBe(false);
    expect(lineIsPerInvoice("")).toBe(false);
  });
});

describe("divisor — ASLI MAAMLA", () => {
  it("monthly flex, 12 invoice/yr → 1 se baanto (yaani baanto hi mat)", () => {
    expect(perInvoiceDivisor(12, "monthly")).toBe(1);
  });

  it("annual commitment, 12 invoice/yr → 12 se baanto", () => {
    /* Ye asli aur aam surat hai: saal ka sauda, baarah kishton me bill. Ise todna nahi hai. */
    expect(perInvoiceDivisor(12, "annual_yearly")).toBe(12);
  });

  it("saalana bill par dono ek jaise — 1", () => {
    expect(perInvoiceDivisor(1, "monthly")).toBe(1);
    expect(perInvoiceDivisor(1, "annual_yearly")).toBe(1);
  });

  it("Q-0053 ke asli aankde", () => {
    /* subtotal 11,700 ek MAHINA hai. Purana code 11,700/12 = 975 chhapta tha. */
    const subtotal = 11_700;
    expect(subtotal / perInvoiceDivisor(12, "monthly")).toBe(11_700);
    expect(subtotal / perInvoiceDivisor(12, "annual_yearly")).toBe(975);
  });
});

describe("Annual contract value — divisor ka aaina", () => {
  it("monthly flex par saal = barah mahine", () => {
    /* PDF ne 13,392 chhapa tha, jo ek MAHINE ka total tha. Saal 12 guna hai. */
    expect(annualContractValue(13_392, 12, "monthly")).toBe(160_704);
  });

  it("annual commitment par stored total PEHLE SE saal hai", () => {
    expect(annualContractValue(160_704, 12, "annual_yearly")).toBe(160_704);
  });

  it("saalana bill par kuch nahi badalta", () => {
    expect(annualContractValue(160_704, 1, "annual_yearly")).toBe(160_704);
  });
});

describe("dono aankde ek doosre se mel khate hain", () => {
  it("per-invoice x invoices-per-year = annual contract value", () => {
    /* Yahi wo baat hai jo document par TOOTI thi: per-month sahi tha aur annual galat,
       aur unka aapas me na milna hi ekmatra ishara tha. */
    for (const commitment of ["monthly", "annual_yearly"]) {
      const stored = 13_392;
      const n = 12;
      const perInv = stored / perInvoiceDivisor(n, commitment);
      expect(Math.round(perInv * n), commitment).toBe(annualContractValue(stored, n, commitment));
    }
  });
});
