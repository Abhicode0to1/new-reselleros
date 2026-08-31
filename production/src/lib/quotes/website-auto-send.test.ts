import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideAutoSend } from "./auto-send-quote";

/* ─────────────────────────────────────────────────────────────────────────────
   WEBSITE ka auto-SEND — Pardeep ka faisla, 31 Aug 2026: "poora auto-SEND bhi kar do."

   Do cheezein pin hain:

   1. NIYAM — website (buy-page/quote-form) se aayi annual enquiry par wahi gates lagte
      hain jo email-enquiry par lagte hain. Naya send-path NAHI bana; wahi decideAutoSend,
      wahi sendAutoQuote. Do sender hote to ek din alag-alag vyavhaar karte — wahi drift
      jisse is repo ka har bada bug nikla hai.

   2. FLEX = FLEX — "Monthly, flexible" chunne par draft flexible daam par banta hai
      (buildWorkspaceFlexLines — per seat per MONTH, koi ×12 nahi) aur wahi gates paar
      karke auto-send hota hai. Hold sirf tab jab catalogue me flexible daam hi na ho.
   ───────────────────────────────────────────────────────────────────────────── */

const route = readFileSync(
  join(process.cwd(), "src", "app", "api", "public", "enquiry", "workspace", "route.ts"),
  "utf8",
);

describe("workspace route — wahi gates, wahi sender", () => {
  it("decideAutoSend aur sendAutoQuote dono import hote hain — apna send-path nahi", () => {
    expect(route).toContain('from "@/lib/quotes/auto-send-quote"');
    expect(route).toContain('from "@/lib/quotes/send-auto-quote"');
    expect(route).toContain("decideAutoSend({");
    expect(route).toContain("sendAutoQuote(admin, {");
  });

  it("flex maanga to flex HI banta hai — buildWorkspaceFlexLines, ×12 nahi", () => {
    /* Pardeep, isi din thodi der baad: "flex wale flex ka quote bhejo … 12 invoices wala
       koi chakkar nahi, pay-as-you-go." Pehle yahan monthly ka blanket hold pin tha;
       ab flex draft flex daam par banta hai aur wahi gates paar karke auto-send hota hai. */
    expect(route).toContain("buildWorkspaceFlexLines");
    expect(route).toContain('billing_cycle: usingFlex ? "monthly" : "yearly"');
  });

  it("EK hold bacha hai: flex maanga par catalogue me flexible daam hi nahi", () => {
    /* Tab draft annual daam par hota hai — use bina aadmi ke bhejna maang ke khilaaf
       commitment grahak ke haath me de deta. */
    expect(route).toContain("wantFlex && !usingFlex");
    expect(route).toContain("reprice it before sending");
  });

  it("hold hone par lead par wahi sentence-shape likhta hai jo inbound likhta hai", () => {
    expect(route).toContain("Quote not sent automatically —");
  });

  it("termAssumed false BY CONSTRUCTION — billing enum hai, andaza nahi", () => {
    expect(route).toContain("termAssumed: false");
  });
});

describe("gates website ke input par bhi wahi jawab dete hain", () => {
  const base = {
    termAssumed: false,
    seats: 20,
    seatsHeardNotWritten: false,
    recipient: "customer@example.com",
    quoteId: "Q-ADPL-2026-27-0108",
    emailConfigured: true,
    senderIsOurs: false,
    isSelfTest: false,
  };

  it("20 seats, annual, sab theek → SEND", () => {
    expect(decideAutoSend(base)).toEqual({ send: true });
  });

  it("51+ seats → rukta hai (₹8L class ka unattended kaam nahi)", () => {
    const d = decideAutoSend({ ...base, seats: 51 });
    expect(d.send).toBe(false);
  });

  it("apne hi pate se → kabhi nahi (loop band)", () => {
    const d = decideAutoSend({ ...base, senderIsOurs: true });
    expect(d.send).toBe(false);
  });

  it("email configure nahi → rukta hai, error nahi", () => {
    const d = decideAutoSend({ ...base, emailConfigured: false });
    expect(d.send).toBe(false);
  });
});
