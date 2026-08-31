import { describe, it, expect } from "vitest";
import { shouldRequoteOnReply } from "./requote-on-reply";

const STARTER = "Google Workspace Business Starter";
const STANDARD = "Google Workspace Business Standard";

describe("the live case this was written for", () => {
  it("re-quotes when a reply raises the seat count", () => {
    /* The actual self-test, 23 Aug 2026: a mail asking for 50 Business Starter arrived on a
       lead already carrying 20 Business Standard. The extractor rewrote the lead and no quote
       was drafted, because the auto-quote block was on the CREATE branch only. */
    const d = shouldRequoteOnReply({ term: null,
      seats: 50,
      productName: STARTER,
      latestQuote: { id: "Q-1", billingCycle: null, status: "sent", seats: 20, plan: STANDARD },
    });
    expect(d.requote).toBe(true);
    expect(d.reason).toMatch(/both changed/);
  });
});

describe("when a new quote is right", () => {
  it("quotes a lead that has none", () => {
    const d = shouldRequoteOnReply({ term: null, seats: 50, productName: STARTER, latestQuote: null });
    expect(d.requote).toBe(true);
    expect(d.reason).toMatch(/no quote yet/);
  });

  it("re-quotes on a seat change alone, and names both numbers", () => {
    const d = shouldRequoteOnReply({ term: null,
      seats: 50, productName: STARTER,
      latestQuote: { id: "Q-7", billingCycle: null, status: "sent", seats: 20, plan: STARTER },
    });
    expect(d.requote).toBe(true);
    expect(d.reason).toContain("20 → 50");
  });

  it("re-quotes on a plan change alone", () => {
    const d = shouldRequoteOnReply({ term: null,
      seats: 50, productName: STANDARD,
      latestQuote: { id: "Q-7", billingCycle: null, status: "sent", seats: 50, plan: STARTER },
    });
    expect(d.requote).toBe(true);
    expect(d.reason).toMatch(/plan changed/);
  });

  it("re-quotes even when the old quote was already SENT", () => {
    /* Deliberate. A customer sent 20 seats who now says 50 needs a revised document, not a
       note on a lead. The old quote is not altered — a new one is drafted, and the issued
       figures on the old are frozen by the invoice/quote guards. */
    const d = shouldRequoteOnReply({ term: null,
      seats: 100, productName: STARTER,
      latestQuote: { id: "Q-9", billingCycle: null, status: "accepted", seats: 50, plan: STARTER },
    });
    expect(d.requote).toBe(true);
  });
});

describe("when it must NOT quote — this is where the document numbers are saved", () => {
  it("does not re-quote when nothing changed", () => {
    /* THE ONE THAT MATTERS. A thread about the same 50 seats can run five messages long;
       without this, every one of them is a new GST document for a requirement that has not
       moved, and each takes an irreversible number from the gapless Rule 46 series. */
    const d = shouldRequoteOnReply({ term: null,
      seats: 50, productName: STARTER,
      latestQuote: { id: "Q-4", billingCycle: null, status: "sent", seats: 50, plan: STARTER },
    });
    expect(d.requote).toBe(false);
    expect(d.reason).toContain("Q-4");
    expect(d.reason).toMatch(/does not change what they asked for/);
  });

  it("treats a slug and a catalogue name as the same plan when containment holds", () => {
    /* The lead's `plan` has held both forms — a buy-page slug and the catalogue's own name —
       and this uses the SAME samePlan as apply-correction.ts rather than a second copy. */
    const d = shouldRequoteOnReply({ term: null,
      seats: 50, productName: STARTER,
      latestQuote: { id: "Q-4", billingCycle: null, status: "draft", seats: 50, plan: "business-starter" },
    });
    expect(d.requote).toBe(false);
  });

  it("DOES re-quote once when the dropped word is in the middle of the name", () => {
    /* Asserting the real limitation rather than an invented capability. My first version of
       this test expected "google-workspace-starter" to match "Google Workspace Business
       Starter"; it does not, because samePlan is containment and "business" sits in the
       middle. The function was right and the test was wrong.

       Cost: ONE extra quote on a lead still carrying a buy-page slug. The correction
       write-back then normalises the row onto the catalogue name and it settles. Widening
       samePlan to token-subset matching would fix it and is a SEPARATE change — its own
       comment warns that "Business Starter" and "Business Standard" must never collapse, and
       that warning is load-bearing. */
    const d = shouldRequoteOnReply({ term: null,
      seats: 50, productName: STARTER,
      latestQuote: { id: "Q-4", billingCycle: null, status: "draft", seats: 50, plan: "google-workspace-starter" },
    });
    expect(d.requote).toBe(true);
  });

  it.each([
    [null, STARTER],
    [50, null],
    [null, null],
  ])("does not quote with seats=%s product=%s", (seats, productName) => {
    /* Not a refusal so much as nothing to price. Said here rather than one layer down, so
       the reason lands on the lead's timeline. */
    const d = shouldRequoteOnReply({ term: null, seats, productName, latestQuote: null });
    expect(d.requote).toBe(false);
    expect(d.reason).toMatch(/nothing to price/);
  });

  it("does not treat an unknown old seat count as a match", () => {
    /* A quote with null seats tells us nothing about whether the requirement moved, and
       "unknown equals 50" would skip a needed revision. */
    const d = shouldRequoteOnReply({ term: null,
      seats: 50, productName: STARTER,
      latestQuote: { id: "Q-5", billingCycle: null, status: "draft", seats: null, plan: STARTER },
    });
    expect(d.requote).toBe(true);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   TERM AANA BHI EK BADLAV HAI — 31 Aug 2026.

   Q-ADPL-2026-27-0055: 32 seats, Business Starter, ANDAZE ke annual term par draft hua, aur
   theek hi nahi bheja gaya — monthly aur annual me 12 guna ka farq hai. Agent ne customer ko
   uska number bhi bata diya aur likha "confirm karein, phir formal quotation bhejta hoon".

   Phir customer "monthly" likhta — wahi seats, wahi plan — aur ye function kehta "reply ne
   kuch badla nahi". Yaani draft annual par pada rehta, kabhi bheja na jata, aur wo vaada
   kabhi poora na hota. Jo ek cheez bhejne se rok rahi thi, wo faisle me shaamil hi nahi thi.

   Pardeep ka faisla (dono raaste saamne rakh kar): bina-bheje draft ka DAAM theek karo, wahi
   number rakho. Number GST ki gapless series se aata hai aur wapas nahi milta; aur jo
   reference customer ko de diya gaya hai, wo sach reh jata hai.
   ───────────────────────────────────────────────────────────────────────────── */
const STARTER_NAME = "Google Workspace Business Starter";
const draft = (billingCycle: string | null) => ({
  id: "Q-ADPL-2026-27-0055", status: "draft", seats: 32,
  plan: STARTER_NAME, billingCycle,
});

describe("bina-bheja draft, aur ab term maloom hai", () => {
  it("ASLI MAAMLA — annual draft par customer ne 'monthly' kaha", () => {
    const d = shouldRequoteOnReply({
      seats: 32, productName: STARTER_NAME, term: "monthly", latestQuote: draft("yearly"),
    });
    expect(d.requote).toBe(true);
    expect(d.repriceDraftId, "usi draft ka daam theek hona chahiye").toBe("Q-ADPL-2026-27-0055");
    expect(d.reason).toContain("re-pricing that draft");
  });

  it("ulta bhi — monthly draft par 'annual'", () => {
    const d = shouldRequoteOnReply({
      seats: 32, productName: STARTER_NAME, term: "annual", latestQuote: draft("monthly"),
    });
    expect(d.requote).toBe(true);
    expect(d.repriceDraftId).toBe("Q-ADPL-2026-27-0055");
  });

  it("wahi term dobara kaha to KUCH NAHI — number bachta hai", () => {
    /* Paanch message ki baat-cheet me har baar "monthly" likha ja sakta hai. */
    const d = shouldRequoteOnReply({
      seats: 32, productName: STARTER_NAME, term: "monthly", latestQuote: draft("monthly"),
    });
    expect(d.requote).toBe(false);
    expect(d.repriceDraftId).toBeUndefined();
  });

  it("term nahi bataya to purana vyavhaar — kuch nahi", () => {
    const d = shouldRequoteOnReply({
      seats: 32, productName: STARTER_NAME, term: null, latestQuote: draft("yearly"),
    });
    expect(d.requote).toBe(false);
  });
});

describe("BHEJA HUA document kabhi nahi badla jata", () => {
  for (const status of ["sent", "accepted", "rejected"]) {
    it(`status "${status}" par daam theek NAHI kiya jata`, () => {
      /* Ek jaari kiya gaya document ke aankde jam jate hain. Customer ke haath me jo kaagaz
         hai, use peeche se badalna hi wo cheez hai jiske liye Rule 46 ki series banti hai. */
      const d = shouldRequoteOnReply({
        seats: 32, productName: STARTER_NAME, term: "monthly",
        latestQuote: { ...draft("yearly"), status },
      });
      expect(d.repriceDraftId, `${status} par reprice nahi hona chahiye`).toBeUndefined();
      /* Aur kuch badla bhi nahi hai — seats aur plan wahi hain — to naya quote bhi nahi. */
      expect(d.requote).toBe(false);
    });
  }
});

describe("billing_cycle maloom na ho", () => {
  it("null par reprice nahi — andaze par document nahi chheda jata", () => {
    /* Purane quote me column khaali ho sakta hai. Us haal me "galat term par hai" kehna khud
       ek andaza hoga, aur andaze par ek maujooda document badalna nahi chahiye. */
    const d = shouldRequoteOnReply({
      seats: 32, productName: STARTER_NAME, term: "monthly", latestQuote: draft(null),
    });
    expect(d.repriceDraftId).toBeUndefined();
    expect(d.requote).toBe(false);
  });
});
