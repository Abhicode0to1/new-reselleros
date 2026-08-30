import { describe, it, expect } from "vitest";
import { claimsQuoteExists, unbackedQuoteClaim } from "./quote-claim";
import { applyHandoverRules, type SalesAgentDecision } from "./sales-agent";

/* ─────────────────────────────────────────────────────────────────────────────
   30 Aug 2026, ek asli pate par gaya hua mail:

     "Thank you for confirming. The quotation for 40 seats of Google Workspace Business
      Starter on monthly billing HAS BEEN PREPARED at Rs 325 per seat per month, plus 18%
      GST, with our 3% volume discount applied."

   Aisa koi quotation tha hi nahi. `quotes` me us lead ka kuch nahi tha — mail me likha
   product catalogue se mel nahi khaya, auto-quote ne theek hi mana kar diya, aur lead par
   teen baar likha gaya "No quote drafted automatically". Agent ko ye kabhi bataya nahi
   gaya, aur usne customer se ulta keh diya — usi vaakya me daam ke saath.

   Agar customer kahe "wo quotation bhejiye", to dene ko kuch nahi hai.
   ───────────────────────────────────────────────────────────────────────────── */

const LIVE =
  "Thank you for confirming.\n\nThe quotation for 40 seats of Google Workspace Business " +
  "Starter on monthly billing has been prepared at Rs 325 per seat per month, plus 18% GST, " +
  "with our 3% volume discount applied.";

describe("dava pakadna", () => {
  it("asli mail wala vaakya pakda jata hai", () => {
    const m = claimsQuoteExists(LIVE);
    expect(m).toBeTruthy();
    expect(m).toMatch(/has been prepared/i);
  });

  it("dave ke doosre roop bhi", () => {
    for (const s of [
      "Quotation Q-1 has been created for 20 seats.",
      "I have prepared the quotation for you.",
      "We have raised a quote for 30 seats.",
      "The quotation is attached.",
      "Your quote is ready.",
      "Please find the quotation below.",
      "Find attached the quote for 15 seats.",
    ]) {
      expect(claimsQuoteExists(s), s).toBeTruthy();
    }
  });
});

describe("bhavishya kaal SAHI hai — yahi is file ki poori mushkil hai", () => {
  it("'I will prepare' rok nahi lagti", () => {
    /* Jab kuch bana hi nahi, tab agent ko YAHI kehna CHAHIYE. Agar ye bhi ruk jata, to
       agent ke paas kehne ko kuch bachta hi nahi aur feature mar jata. */
    for (const s of [
      "I will prepare the quotation once you confirm the billing term.",
      "Confirm annual or monthly and I will prepare the quotation.",
      "Send me the seat count and I will prepare a quote.",
      "Shall I prepare the quotation?",
      "The quotation will be prepared after you confirm.",
    ]) {
      expect(claimsQuoteExists(s), s).toBeNull();
    }
  });

  it("bina quote ki baat wale vaakya bhi saaf nikal jate hain", () => {
    for (const s of [
      "The price is Rs 325 per seat per month plus 18% GST.",
      "We have prepared a migration plan for your team.",
      "",
      "   ",
    ]) {
      expect(claimsQuoteExists(s), s).toBeNull();
    }
  });

  it("null / undefined par crash nahi", () => {
    expect(claimsQuoteExists(null)).toBeNull();
    expect(claimsQuoteExists(undefined)).toBeNull();
  });
});

describe("reference ho to dava SAHI hai — tab rokna galat hoga", () => {
  it("quote id maujood ho to wahi vaakya nikal jata hai", () => {
    /* Yahi wo halat hai jisme agent ko bolna chahiye. Reference hi is dave ka adhikar hai. */
    expect(unbackedQuoteClaim(LIVE, "Q-ADPL-2026-27-0044")).toBeNull();
  });

  it("khaali ya sirf space wala reference, reference nahi hai", () => {
    expect(unbackedQuoteClaim(LIVE, "")).toBeTruthy();
    expect(unbackedQuoteClaim(LIVE, "   ")).toBeTruthy();
    expect(unbackedQuoteClaim(LIVE, null)).toBeTruthy();
  });

  it("reference na ho par dava bhi na ho — tab bhi theek", () => {
    expect(unbackedQuoteClaim("Confirm the term and I will prepare the quotation.", null)).toBeNull();
  });
});

/* ── Aur ye sirf ek function ka test nahi, GUARD tak juda hua hai ──────────── */

describe("guard tak pahunchta hai — prompt akela kaafi nahi", () => {
  const draft = (body: string): SalesAgentDecision => ({
    customer_intent: "wants a quote for 40 seats",
    perceived_sentiment: "interested",
    confidence_score: 0.9,
    action_required: "REPLY",
    handover_reason: null,
    generated_response: {
      email_subject: "Re: quote",
      body_text: body,
      whatsapp_summary: "quote",
    },
    next_followup_loop: { in_hours: 48, trigger_condition: "no reply" },
    seats_discussed: 40,
  });

  it("bina quote ke dava karne wala draft RUK jata hai", () => {
    /* Prompt ab saaf mana karta hai — par prompt ek guzarish hai. Aaj do baar sirf nirdesh
       sikke ka uchhaal nikla (seat count aur "discount" ka aankda). Ye ek DOCUMENT ke
       hone ka dava hai, customer se, daam ke saath — ise wahi pehra milna chahiye. */
    const r = applyHandoverRules({
      decision: draft("The quotation for 40 seats has been prepared. Confirm and we will proceed."),
      seats: 40,
      allowedMoney: [129600],
      quoteRef: null,
    });
    /* Koi daam nahi likha — warna paise wala pehra pehle pakad leta aur ye test kuch aur
       jaanch raha hota. Pehli koshish me theek wahi hua tha. */
    expect(r.decision.action_required).toBe("HANDOVER_TO_HUMAN");
    expect(r.overruled).toBe(true);
    expect(r.reason).toMatch(/quotation exists/i);
    /* Wajah me draft ke apne shabd hone chahiye — "usne dava kiya" jaanchne layak nahi hai. */
    expect(r.reason).toMatch(/has been prepared/i);
  });

  it("quote ka reference ho to wahi draft NIKAL jata hai", () => {
    const r = applyHandoverRules({
      decision: draft("Quotation Q-ADPL-2026-27-0044 has been prepared for 40 seats."),
      seats: 40,
      allowedMoney: [129600],
      quoteRef: "Q-ADPL-2026-27-0044",
    });
    expect(r.decision.action_required).not.toBe("HANDOVER_TO_HUMAN");
  });

  it("bhavishya kaal wala draft bina reference ke bhi nikal jata hai", () => {
    /* Yahi wo vaakya hai jo aaj dry run me asli model ne likha, fix ke baad. */
    const r = applyHandoverRules({
      decision: draft("Confirm annual or monthly billing and I will prepare the quotation."),
      seats: 40,
      allowedMoney: [129600],
      quoteRef: null,
    });
    expect(r.decision.action_required).not.toBe("HANDOVER_TO_HUMAN");
  });
});
