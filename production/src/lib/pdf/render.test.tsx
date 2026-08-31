import { describe, it, expect } from "vitest";
import { QuotePDF, type QuotePDFProps } from "./QuotePDF";

/* ─────────────────────────────────────────────────────────────────────────────
   Is repo ka PEHLA test jo sach me ek PDF render karta hai.

   Ab tak `src/lib/pdf` me koi bhi PDF nahi banata tha, aur usi khaali jagah me do galtiyan
   mahino chhupi rahin: renderer maasik daam ko 12 se baant raha tha, aur `tenants.logo_url`
   July se bhara pada tha par koi document use padhta hi nahi tha. Dono cheezein document
   KHOLE bina nahi dikhti thi — aur jise dekhne ke liye document kholna pade, use koi nahi
   dekhta.

   Dhima hai (~1s), isliye sirf do baaten jaanchta hai jo sirf yahan jaanchi ja sakti hain.
   ───────────────────────────────────────────────────────────────────────────── */

/** 1x1 PNG. Asli bytes chahiye — renderer inhe decode karta hai — par network nahi. */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const base: QuotePDFProps = {
  tenantName: "ANUTECH DIGITAL PVT LTD",
  tenantGstin: "07ABDCA0298H1ZP",
  tenantEmail: "pardeep@anutech.in",
  tenantPhone: "+91 98765 43210",
  tenantAddress: "Delhi",
  quoteId: "Q-TEST-0001",
  customerName: "Test Co",
  validityDays: 7,
  lineItems: [{ name: "Google Workspace Business Starter", qty: 45, rate: 325, cost: 300, commitment: "monthly" }] as QuotePDFProps["lineItems"],
  subtotal: 14_625, discountPct: 0, discount: 0,
  taxable: 14_625, taxRate: 18, tax: 2_633, total: 17_258,
  interState: false,
  billingCycle: "monthly",
};

async function render(props: QuotePDFProps): Promise<Buffer> {
  const { renderToBuffer } = await import("@react-pdf/renderer");
  return await renderToBuffer(
    <QuotePDF {...props} /> as unknown as Parameters<typeof renderToBuffer>[0],
  );
}

describe("logo document par sach me chhapta hai", () => {
  it("logo dene par PDF me image aa jati hai, na dene par nahi", async () => {
    const [withLogo, without] = await Promise.all([
      render({ ...base, tenantLogo: TINY_PNG }),
      render(base),
    ]);
    /* Bas "bada file" nahi — PDF me image XObject ka hona hi saboot hai. */
    expect(withLogo.includes(Buffer.from("/Subtype /Image")), "logo wale PDF me image object nahi mila").toBe(true);
    expect(without.includes(Buffer.from("/Subtype /Image")), "bina logo wale PDF me image kahan se aaya").toBe(false);
  }, 60_000);

  it("URL dene par IMAGE NAHI banti — par ye jaanch KAMZOR hai, aur wo likha hua hai", async () => {
    /* Ye pass hoti hai, par guard hataane par BHI pass hoti hai — maine naapa: hasLogo ko
       Boolean(tenantLogo) karke dekha aur ye hari hi rahi. Wajah: test me wo URL pahunch se
       bahar hai, to renderer chup-chaap image chhod deta hai. Yaani ye rail ka saboot NAHI
       hai; ye sirf itna kehti hai ki ek anup-labdh URL document ko todta nahi.

       Asli rail logo-wiring.test.ts me pin hai — wahan QuotePDF ka source padha jata hai
       aur wahi mutation par laal hoti hai. Ise yahan isliye chhoda hai kyunki ye us surat
       ko dekhti hai jo asli me ho sakti hai: storage neeche hai, aur quote phir bhi jaana
       chahiye. */
    const urlNotDataUri = await render({ ...base, tenantLogo: "https://cdn.example/logo.png" });
    expect(urlNotDataUri.length, "document banna hi chahiye").toBeGreaterThan(1000);
    expect(urlNotDataUri.includes(Buffer.from("/Subtype /Image"))).toBe(false);
  }, 60_000);
});

/* Yahan text ki koi jaanch NAHI hai, aur ye jaan-boojh kar hai. Maine likhi thi — "maasik
   PDF me 'Annual contract value' nahi hona chahiye" — aur wo hari bhi ho gayi. Phir uske
   saath rakha CONTROL (saalana PDF me wahi shabd HONA chahiye) laal ho gaya: react-pdf font
   subset ke glyph code likhta hai, to koi bhi shabd kabhi nahi milta. Yaani wo jaanch hamesha
   hari rehti, hamesha bina kuch jaanche.

   Us niyam ko flex-has-no-year.test.ts source padh kar pakadta hai, aur wo mutation-checked
   hai. Control na hota to yahan ek jhootha green baith jata. */

/* ─── Invoice aur Receipt Voucher ─────────────────────────────────────────────
   Ye dono GST document hain, aur inme brand mark ka koi khaana tha hi nahi — quote par
   monogram tha, in par kuch bhi nahi. Logo ab title ke upar, beech me, letterhead ki tarah
   aata hai. Neeche ke "From (Supplier)" / "Bill to" block hi kanooni pehchan hain; logo
   sajawat hai aur unhe hataata nahi. */
describe("invoice aur receipt par bhi logo", () => {
  it("Tax Invoice — logo dene par image, na dene par nahi", async () => {
    const { renderToBuffer } = await import("@react-pdf/renderer");
    const { InvoicePDF } = await import("./InvoicePDF");
    const props = {
      invoice: { id: "INV-TEST-0001", customer_name: "Test Co", amount: 17_258,
        invoice_date: "2026-08-31", status: "unpaid" },
      lineItems: [{ name: "Google Workspace", qty: 45, rate: 325, cost: 300 }],
      subtotal: 14_625, discountPct: 0, discount: 0,
      taxable: 14_625, taxRate: 18, tax: 2_633, total: 17_258, interState: false,
      tenantName: "ANUTECH DIGITAL PVT LTD", tenantGstin: "07ABDCA0298H1ZP",
    };
    const draw = (logo?: string) => renderToBuffer(
      (<InvoicePDF {...(props as unknown as React.ComponentProps<typeof InvoicePDF>)} tenantLogo={logo} />) as unknown as Parameters<typeof renderToBuffer>[0]);

    const [withLogo, without] = await Promise.all([draw(TINY_PNG), draw()]);
    expect(withLogo.includes(Buffer.from("/Subtype /Image")), "invoice par logo nahi aaya").toBe(true);
    expect(without.includes(Buffer.from("/Subtype /Image")), "bina logo ke image kahan se aayi").toBe(false);
  }, 60_000);

  it("Receipt Voucher — wahi", async () => {
    const { renderToBuffer } = await import("@react-pdf/renderer");
    const { ReceiptVoucherPDF } = await import("./ReceiptVoucherPDF");
    const props = {
      payment: { id: "RV-TEST-0001", amount: 17_258, payment_date: "2026-08-31", method: "upi" },
      customerName: "Test Co",
      tenantName: "ANUTECH DIGITAL PVT LTD", tenantGstin: "07ABDCA0298H1ZP",
    };
    const draw = (logo?: string) => renderToBuffer(
      (<ReceiptVoucherPDF {...(props as unknown as React.ComponentProps<typeof ReceiptVoucherPDF>)} tenantLogo={logo} />) as unknown as Parameters<typeof renderToBuffer>[0]);

    const [withLogo, without] = await Promise.all([draw(TINY_PNG), draw()]);
    expect(withLogo.includes(Buffer.from("/Subtype /Image")), "receipt par logo nahi aaya").toBe(true);
    expect(without.includes(Buffer.from("/Subtype /Image")), "bina logo ke image kahan se aayi").toBe(false);
  }, 60_000);
});
