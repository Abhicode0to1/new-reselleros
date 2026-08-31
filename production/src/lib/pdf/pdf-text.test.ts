import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pdfText, undrawable, drawableInWinAnsi } from "./pdf-text";

/* ─────────────────────────────────────────────────────────────────────────────
   31 Aug 2026. ₹ ka bug theek karne ke baad usi shaam ke audit ne bataya ki fix DO tarah se
   tang tha:

     1. `InvoicePDF.tsx:556` par `✓ Advances adjusted against this invoice` likha tha. U+2713
        bhi WinAnsi me nahi hai — yaani jis invoice par advance adjust hua, uspar DOOSRA toota
        nishaan tha. Wo ₹ ke bug ke bilkul paas tha aur maine sirf ₹ dekha.

     2. Document ka bahut sa matn HUM likhte hi nahi: `customerName`, `notes`,
        `termsConditions`, line ka `name`, dono address. Koi tenant Terms me ₹ type kar de,
        kisi customer ka naam Hindi me ho, ya `→` paste ho jaye — wahi tooti shakl, GST
        document par, aur code me kuch galat nahi dikhega.

   Isliye sawaal badal gaya: "ye figure convert karna yaad rakha?" ki jagah "font ye string
   bana bhi sakta hai?".
   ───────────────────────────────────────────────────────────────────────────── */

describe("jo font bana sakta hai", () => {
  it("ASCII, Latin-1, aur WinAnsi ke extra — sab theek", () => {
    for (const ch of "Rs 12,675 abc XYZ 0-9 · — – € £ ' ' \" \" • …") {
      expect(drawableInWinAnsi(ch.codePointAt(0)!), ch).toBe(true);
    }
  });

  it("em dash aur middle dot BANTE hain — inhe chhedna nahi", () => {
    /* Ye dono documents me har jagah hain ("Per seat · HSN 998313"). Agar ye bhi badal diye
       jaate to fix se zyada nuksaan hota. */
    expect(pdfText("Per seat · HSN 998313")).toBe("Per seat · HSN 998313");
    expect(pdfText("None — cancel any month")).toBe("None — cancel any month");
  });

  it("₹ aur ✓ nahi bante — ASLI DONO MAAMLE", () => {
    expect(drawableInWinAnsi(0x20b9)).toBe(false);
    expect(drawableInWinAnsi(0x2713)).toBe(false);
  });
});

describe("pdfText — badalta hai, chhupata nahi", () => {
  it("₹ -> Rs", () => {
    expect(pdfText("₹12,675/mo")).toBe("Rs 12,675/mo");
  });

  it("✓ -> + (invoice ka advances header)", () => {
    expect(pdfText("✓ Advances adjusted")).toBe("+ Advances adjusted");
  });

  it("teer aur ganit ke nishaan padhne layak ban jate hain", () => {
    expect(pdfText("20 → 50 seats")).toBe("20 -> 50 seats");
    expect(pdfText("≥ 50 seats")).toBe(">= 50 seats");
  });

  it("jo list me nahi hai wo GIRA diya jata hai, badla nahi", () => {
    /* Jaan-boojh kar. Ek gayab akshar typo lagta hai; badli hui shakl KHARABI lagti hai —
       aur ek tax invoice par doosra zyada bura hai. Girane se string lambi bhi nahi hoti, to
       layout nahi hilta. */
    expect(pdfText("Ram नमस्ते Co")).toBe("Ram  Co");
    expect(pdfText("emoji 🎉 gone")).toBe("emoji  gone");
  });

  it("saaf matn bilkul waisa hi nikalta hai", () => {
    /* Isiliye ise har jagah lagaya ja sakta hai — sochna nahi padta ki kaunsa field "ganda"
       ho sakta hai. Yaad rakhna hi wo cheez thi jo fail hui. */
    const clean = "ANUTECH DIGITAL PVT LTD — Google Workspace Business Starter";
    expect(pdfText(clean)).toBe(clean);
  });

  it("dobara lagane se kuch nahi badalta", () => {
    expect(pdfText(pdfText("₹325"))).toBe(pdfText("₹325"));
  });

  it("null / undefined par khaali string", () => {
    expect(pdfText(null)).toBe("");
    expect(pdfText(undefined)).toBe("");
  });

  it("undrawable() batata hai kaun-kaun bacha", () => {
    expect(undrawable("₹ ✓ theek")).toEqual([]);
    expect(undrawable("नमस्ते").length).toBeGreaterThan(0);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   AUR AB PEHRA — bahar se aane wala har field pdfText se guzre.

   Ye list aankh se nahi banti. 39 email call site me se 17 `route` bhool gaye the aur ₹ ka
   fix teen document par laga jabki chautha (payslip) pehle se jaanta tha. Ginti hoti hai.
   ───────────────────────────────────────────────────────────────────────────── */
describe("PDF me bahar ka matn pdfText se guzarta hai", () => {
  const DIR = join(process.cwd(), "src", "lib", "pdf");

  /* Wo field jinka matn tenant/customer/catalogue se aata hai — hamare label nahi. */
  const USER_FIELDS = [
    "customerName", "notes", "termsConditions", "tenantName",
    "customerAddress", "tenantAddress", "contactName",
  ];

  const components = readdirSync(DIR).filter(
    (f) => /PDF\.tsx$/.test(f) && !/\.test\./.test(f),
  );

  it("component mile bhi", () => {
    expect(components.length).toBeGreaterThanOrEqual(4);
  });

  for (const f of components) {
    it(`${f} — koi user field bina pdfText render nahi hota`, () => {
      const code = readFileSync(join(DIR, f), "utf8")
        .replace(/\r\n?/g, "\n")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((l) => l.replace(/\s\/\/.*$/, ""))
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n");

      const bare: string[] = [];
      for (const field of USER_FIELDS) {
        /* JSX text node: `>{field}<`. Prop declaration aur destructure isse nahi milte. */
        if (code.includes(">{" + field + "}<")) bare.push(field);
      }
      expect(bare, `${f}: ye field seedha render ho rahe hain — ${bare.join(", ")}`)
        .toEqual([]);
    });
  }
});
