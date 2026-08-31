import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replyToAddress } from "./reply-to";

/* ─────────────────────────────────────────────────────────────────────────────
   31 Aug 2026, 14:32 — ek asli reply gayab ho gaya.

   Pardeep ne quote email ka jawab diya: "mujhe 66 email id ka quote chahiye". App ne use
   dekha hi nahi — us aadhe ghante me `inbound_emails` me ek bhi row nahi. Na held, na skipped,
   na spam. Wo pahuncha hi nahi.

     quote email par lagta tha   replyTo: tenants.email  ->  pardeep@anutech.in
     connector padhta hai                                    sales@anutech.in

   Yaani jawab us mailbox me gira jise app padhti hi nahi, aur kahin kuch likha bhi nahi gaya.
   Gmail ne saaf dikhaya bhi tha — "to pardeep" — us mail ke neeche jo Sales Anutech se aayi
   thi.

   Purana comment laaparwahi nahi tha, PURANA tha: "replies go to the tenant... a customer
   answering this must reach a person." Wo sahi tha jab mail Resend se `onboarding@resend.dev`
   ke naam se jaati thi, jiska jawab koi de hi nahi sakta. Galat us din ho gaya jab app tenant
   ke apne Gmail se bhejne AUR padhne lagi.
   ───────────────────────────────────────────────────────────────────────────── */

const SALES = { google_email: "sales@anutech.in" };
const OWNER = "pardeep@anutech.in";

describe("jawab wahin jaye jahan app padhti hai", () => {
  it("ASLI MAAMLA — connector sales@ padhta hai, to Reply-To sales@ hoga", () => {
    expect(replyToAddress([SALES], OWNER)).toBe("sales@anutech.in");
  });

  it("owner ka address JEETTA NAHI hai jab padha jane wala mailbox maujood ho", () => {
    /* Yahi ek line thi jisne poori baat-cheet pipeline se bahar kar di. */
    expect(replyToAddress([SALES], OWNER)).not.toBe(OWNER);
  });

  it("koi connector nahi → owner ka address, purana vyavhaar", () => {
    /* Bina jude mailbox wale tenant ke liye insaan tak pahunchna behtar hai bilkul kuch na
       hone se. Bas ye PEHLA jawab nahi rahega. */
    expect(replyToAddress([], OWNER)).toBe(OWNER);
    expect(replyToAddress(null, OWNER)).toBe(OWNER);
    expect(replyToAddress(undefined, OWNER)).toBe(OWNER);
  });

  it("dono khaali → undefined, koi header hi nahi", () => {
    expect(replyToAddress([], null)).toBeUndefined();
    expect(replyToAddress([{ google_email: null }], "   ")).toBeUndefined();
  });

  it("khaali ya space wala google_email chhod diya jata hai", () => {
    expect(replyToAddress([{ google_email: "  " }, SALES], OWNER)).toBe("sales@anutech.in");
    expect(replyToAddress([{ google_email: null }], OWNER)).toBe(OWNER);
  });

  it("kai account hon to pehla padha jane wala", () => {
    expect(replyToAddress([SALES, { google_email: "support@anutech.in" }], OWNER))
      .toBe("sales@anutech.in");
  });

  it("space trim hota hai", () => {
    expect(replyToAddress([{ google_email: " sales@anutech.in " }], OWNER))
      .toBe("sales@anutech.in");
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Aur dono jagah — auto-quote aur haath se bheja gaya quote — yahi function use karein.
   Ek par theek karke doosri bhoolna is session ki sabse baar dohrayi gayi galti hai.
   ───────────────────────────────────────────────────────────────────────────── */
describe("dono quote-send raaste ingest mailbox use karte hain", () => {
  const runnable = (parts: string[]): string =>
    readFileSync(join(process.cwd(), "src", ...parts), "utf8")
      .replace(/\r\n?/g, "\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\s\/\/.*$/, ""))
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");

  const SITES: string[][] = [
    ["lib", "quotes", "send-auto-quote.ts"],
    ["app", "api", "quotes", "[id]", "send", "route.ts"],
  ];

  for (const parts of SITES) {
    const name = parts[parts.length - 2] + "/" + parts[parts.length - 1];

    it(`${name} — replyToAddress use karta hai`, () => {
      expect(runnable(parts)).toContain("replyTo: replyToAddress(");
    });

    it(`${name} — tenant.email SEEDHA replyTo me nahi jata`, () => {
      /* Wahi ek line thi. Wapas aayi to jawab phir gayab hone lagenge, chup-chaap. */
      expect(runnable(parts)).not.toMatch(/replyTo:\s*tenant\.email/);
    });
  }
});
