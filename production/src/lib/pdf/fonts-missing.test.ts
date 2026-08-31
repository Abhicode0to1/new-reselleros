import { describe, it, expect, vi } from "vitest";
import { PDF_FONT, PDF_FONT_BOLD, PDF_FONT_HAS_RUPEE, registerPdfFonts } from "./fonts";
import { rupeeIsDrawable, pdfText } from "./pdf-text";
import { pdfRupee } from "./pdf-money";

/* ─────────────────────────────────────────────────────────────────────────────
   FONT KI FILE GAYAB HO TO KYA HOTA HAI.

   Ye alag file hai kyunki `fonts.test.tsx` QuotePDF import karta hai, aur wo import hi font
   register kar deta hai — ek hi file me "register hua" aur "nahi hua", dono nahi ho sakte.

   Aur ye haalat kaal-pnik nahi hai. Font `public/fonts/` me rehta hai aur runtime image me
   `Dockerfile:100` ke `COPY public/` se pahunchta hai. Us ek line ke badalne par file gayab ho
   jayegi — aur tab document ka RENDER FAIL nahi hona chahiye. Ek quote na jaana ek toote glyph
   se bada nuksaan hai.

   ── AUR MOCK `fs` KA NAHI, `cwd` KA HAI ────────────────────────────────────
   Pehle maine `vi.mock("node:fs")` likha tha. Do wajah se hataya: ek, ab code `node:fs` nahi
   `require("fs")` use karta hai (build ki wajah — `fonts.ts` ka header dekho), aur `vi.mock`
   ek CJS `require` ko bharose se nahi pakadta. Doosra, aur zyada zaroori — `existsSync` ko
   mock karne se wo asli lookup hi test se bahar ho jata jise hum jaanchna chahte hain.

   To yahan `process.cwd()` ko ek aisi jagah par mod diya gaya hai jahan `public/fonts` nahi
   hai. `existsSync` ASLI chalta hai, sach me `false` deta hai, aur code ka fallback poora
   asli raaste se guzarta hai.
   ───────────────────────────────────────────────────────────────────────────── */

describe("font ki file nahi mili", () => {
  it("built-in face par wapas, aur \"Rs\" — render fail NAHI", () => {
    const cwd = vi.spyOn(process, "cwd")
      .mockReturnValue("C:/dev/__koi-aisi-jagah-nahi-hai__");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    registerPdfFonts();

    /* Bilkul wahi naam jo pehle style me likhe the. Koi aadha-migrated beech ka naam nahi —
       warna document ek aisi family maangta jo register hui hi nahi, aur react-pdf render ke
       waqt phat jata. */
    expect(PDF_FONT).toBe("Helvetica");
    expect(PDF_FONT_BOLD).toBe("Helvetica-Bold");
    expect(PDF_FONT_HAS_RUPEE).toBe(false);

    expect(rupeeIsDrawable()).toBe(false);
    expect(pdfRupee(8_125)).toBe("Rs 8,125");
    expect(pdfText("₹325/seat/month")).toBe("Rs 325/seat/month");

    /* Chup chaap nahi. Cloud Run ke log me ye line dikhegi. */
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("Noto Sans not found");

    warn.mockRestore();
    cwd.mockRestore();
  });
});
