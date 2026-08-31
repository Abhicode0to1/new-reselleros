import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PDF_FONT, PDF_FONT_BOLD, PDF_FONT_HAS_RUPEE, registerPdfFonts } from "./fonts";
import { pdfText, rupeeIsDrawable, undrawable } from "./pdf-text";
import { pdfRupee } from "./pdf-money";
import { QuotePDF, type QuotePDFProps } from "./QuotePDF";

/* ─────────────────────────────────────────────────────────────────────────────
   Ye test us TRICK ki wajah se likha gaya jo "kaam ho gaya" bol kar kuch nahi karti thi.

   Pehli koshish ne Noto Sans ko `Helvetica` ke NAAM se register kiya, taaki chaaron document
   ki ~40 style lines chhune ki zaroorat na pade. Function ne success diya, `PDF_FONT_HAS_RUPEE`
   `true` ho gaya — aur bana hua PDF me `/BaseFont /Helvetica`, koi `/FontFile2` nahi, aur
   poora file 4 KB ka. pdfkit chaudah standard naam pehle hal karta hai, kisi register kiye
   hue font se pehle.

   Ek boolean "haan" keh raha tha aur document "nahi". Isi wajah se yahan har jaanch PDF ke
   BYTES par hai, flag par nahi:

     · `/FontFile2`  →  ek asli TrueType file document ke andar hai
     · `/BaseFont /Helvetica` ka na hona  →  koi base-14 face istemaal nahi ho raha

   Dono ek saath. Pehla akela "register hua" batata hai, doosra akela "Helvetica nahi hai" —
   par "hamara font sach me draw kar raha hai" sirf dono milkar kehte hain.
   ───────────────────────────────────────────────────────────────────────────── */

const FONT_DIR = join(process.cwd(), "public", "fonts");

const base: QuotePDFProps = {
  tenantName: "ANUTECH DIGITAL PVT LTD",
  tenantGstin: "07ABDCA0298H1ZP",
  quoteId: "Q-FONT-0001",
  customerName: "Test Co",
  validityDays: 7,
  lineItems: [{
    name: "Google Workspace Business Starter",
    qty: 25, rate: 325, cost: 300, commitment: "monthly",
  }] as QuotePDFProps["lineItems"],
  subtotal: 8_125, discountPct: 0, discount: 0,
  taxable: 8_125, taxRate: 18, tax: 1_463, total: 9_588,
  interState: false,
  billingCycle: "monthly",
};

async function render(): Promise<Buffer> {
  const { renderToBuffer } = await import("@react-pdf/renderer");
  return await renderToBuffer(
    <QuotePDF {...base} /> as unknown as Parameters<typeof renderToBuffer>[0],
  );
}

describe("font ki file sach me repo me hai", () => {
  it("dono weight maujood hain", () => {
    /* Ye jaanch is liye hai ki asset gayab hone par test RED ho — warna sab kuch chupchaap
       "Rs" par wapas chala jata aur koi test fail nahi hota. Fallback surakshit hai, par
       khamoshi se fallback par jana ek regression hai. */
    expect(existsSync(join(FONT_DIR, "NotoSans-Regular.ttf")), "NotoSans-Regular.ttf").toBe(true);
    expect(existsSync(join(FONT_DIR, "NotoSans-Bold.ttf")), "NotoSans-Bold.ttf").toBe(true);
  });
});

describe("register hone par constant badalte hain", () => {
  it("QuotePDF import karne se hi register ho jata hai", () => {
    /* Component apne module ke top par `registerPdfFonts()` bulata hai — `StyleSheet.create`
       se PEHLE, kyunki style banate waqt jo value hoti hai wahi hamesha ke liye pakdi jati
       hai. Isi liye yahan register ko dobara bulane ki zaroorat nahi. */
    expect(PDF_FONT).toBe("ResellerSans");
    expect(PDF_FONT_BOLD).toBe("ResellerSans-Bold");
    expect(PDF_FONT_HAS_RUPEE).toBe(true);
  });

  it("dobara bulane par kuch nahi badalta", () => {
    registerPdfFonts();
    registerPdfFonts();
    expect(PDF_FONT).toBe("ResellerSans");
  });
});

describe("₹ ab substitute nahi hota — par baaki sab hota hai", () => {
  it("rupee ka nishaan waisa hi rehta hai", () => {
    expect(rupeeIsDrawable()).toBe(true);
    expect(pdfRupee(8_125)).toBe("₹8,125");
    expect(pdfText("₹325/seat/month")).toBe("₹325/seat/month");
  });

  it("✓ phir bhi + banta hai — Noto Sans me tick NAHI hai", () => {
    /* Dono file ke bytes me dekha gaya: ₹ hai, `✓` nahi. Isliye "font aa gaya, ab kuch
       substitute na karo" GALAT hota — invoice ke advances header par ek gayab glyph laga
       deta. Font ki coverage poori nahi hai, aur ye test wahi line kheenchta hai. */
    expect(pdfText("✓ paid")).toBe("+ paid");
    expect(pdfText("A → B")).toBe("A -> B");
  });

  it("undrawable() bhi ₹ ko chhod deta hai", () => {
    expect(undrawable("₹8,125")).toEqual([]);
    expect(undrawable("✓")).toEqual([]);        // substitute maujood hai
    expect(undrawable("अ")).toEqual(["अ"]);      // Devanagari kisi bhi haal me nahi
  });
});

describe("ASLI SABOOT — bane hue PDF ke bytes", () => {
  it("/FontFile2 maujood, aur koi base-14 Helvetica nahi", async () => {
    const b = await render();

    expect(
      b.includes(Buffer.from("/FontFile2")),
      "/FontFile2 nahi mila — matlab koi TrueType embed hi nahi hua",
    ).toBe(true);

    expect(
      b.includes(Buffer.from("/BaseFont /Helvetica")),
      "/BaseFont /Helvetica mila — pdfkit ne hamare font ki jagah built-in face use kiya",
    ).toBe(false);

    /* Embedded font ka naam. `/BaseFont` par subset prefix (`ABCDEF+`) lagta hai, isliye
       poora naam match nahi karte — sirf face ka naam dhoondhte hain. */
    expect(
      b.includes(Buffer.from("NotoSans")),
      "document me NotoSans ka naam hi nahi hai",
    ).toBe(true);

    /* Aur ek moti jaanch: embed kiye gaye font ke saath file 4 KB ki nahi reh sakti. Wahi
       4 KB purani trick ka pehla sanket tha.

       Pehle maine yahan 100 KB likha tha — font ki file 621 KB ki hai, to poora document us
       se bada hona chahiye. Wo laal hua, 23 KB par. Wajah SUBSETTING hai: pdfkit sirf wahi
       glyph embed karta hai jo document me sach me chhape hain, poora face nahi. To 23 KB
       sahi hai, aur 15 KB ki hadd purani 4 KB wali haalat se saaf alag hai. */
    expect(b.length).toBeGreaterThan(15_000);
  }, 60_000);
});
