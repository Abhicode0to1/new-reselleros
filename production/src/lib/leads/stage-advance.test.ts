import { describe, it, expect } from "vitest";
import { advanceStage, markLost, FUNNEL_ORDER } from "./stage-advance";

/* ══ WO NIYAM JISKE LIYE YE FILE HAI ═══════════════════════════════════════ */

describe("peechhe kabhi nahi", () => {
  it("har aage ke stage se har peechhe ke stage par mana karta hai", () => {
    /* Poora khatra yahi hai. `stage` teen jagah load-bearing hai — heat.ts ka intentTier(),
       heat-score.ts ka funnel progress, aur Deals pipeline ki ginti. Ek peechhe ka move
       board, stage-age badge aur forecast teeno ko galat kar deta hai.

       Ye test har jodi aazmata hai, chuni hui misaalein nahi — kyunki ek nayi stage jodne
       par bhi ye apne aap us par lag jayega. */
    for (let i = 0; i < FUNNEL_ORDER.length; i++) {
      for (let j = 0; j < i; j++) {
        const from = FUNNEL_ORDER[i], to = FUNNEL_ORDER[j];
        const out = advanceStage(from, to);
        expect(out.nextStage, `${from} → ${to} hona hi nahi chahiye`).toBeNull();
        expect(out.reason).toMatch(/peechhe|pehle se/);
      }
    }
  });

  it("har aage ke kadam ko haan kehta hai", () => {
    for (let i = 0; i < FUNNEL_ORDER.length; i++) {
      for (let j = i + 1; j < FUNNEL_ORDER.length; j++) {
        expect(advanceStage(FUNNEL_ORDER[i], FUNNEL_ORDER[j]).nextStage).toBe(FUNNEL_ORDER[j]);
      }
    }
  });

  it("jahan lead pehle se hai, wahin rakhne par kuch nahi likhta", () => {
    for (const s of FUNNEL_ORDER) {
      const out = advanceStage(s, s);
      expect(out.nextStage).toBeNull();
      expect(out.reason).toMatch(/pehle se/);
    }
  });
});

/* ══ TERMINAL STAGES ═══════════════════════════════════════════════════════ */

describe("won aur lost — dono terminal, par wajah alag", () => {
  it("WON ko koi action wapas pipeline me nahi kheench sakta", () => {
    for (const target of FUNNEL_ORDER) {
      const out = advanceStage("won", target);
      expect(out.nextStage).toBeNull();
      expect(out.reason).toMatch(/Won/);
    }
  });

  it("LOST ko kholna ek insaan ka faisla hai, side effect nahi", () => {
    /* Kisi ne soch kar ise band kiya tha. Ek nayi baat-cheet us faisle ka palatna nahi
       hai — warna Lost ka matlab hi khatam ho jata. */
    for (const target of FUNNEL_ORDER) {
      const out = advanceStage("lost", target);
      expect(out.nextStage).toBeNull();
      expect(out.reason).toMatch(/Lost/);
    }
  });
});

/* ══ WO SHAKHAYEN JO CHUP-CHAAP GALAT HO SAKTI THIN ════════════════════════ */

describe("jo pata nahi, use chhodta hai — aur bolta hai", () => {
  it("khaali ya missing stage par kuch nahi karta", () => {
    for (const v of [null, undefined, "", "   "]) {
      const out = advanceStage(v, "contact");
      expect(out.nextStage).toBeNull();
      expect(out.reason).toMatch(/koi stage darj nahi/);
    }
  });

  it("anjaan stage ko aage nahi maanta", () => {
    /* Ye sabse aasan galti hoti: anjaan stage ko "shuruaat me hoga" maan kar aage bhej
       dena. Galat aage ka move utna hi nuksaandeh hai jitna galat peechhe ka, aur DB me
       jodi gayi koi bhi nayi stage isi shakha me girti hai. */
    const out = advanceStage("negotiation", "quote");
    expect(out.nextStage).toBeNull();
    expect(out.reason).toMatch(/nahi hai|pata nahi/);
  });

  it("bade-chhote akshar aur khaali jagah se pareshan nahi hota", () => {
    expect(advanceStage("  NEW  ", "contact").nextStage).toBe("contact");
  });
});

/* ══ LOST KA APNA DARWAZA ══════════════════════════════════════════════════ */

describe("markLost", () => {
  it("kisi bhi khule stage se Lost par le jata hai", () => {
    for (const s of FUNNEL_ORDER) expect(markLost(s).nextStage).toBe("lost");
  });

  it("WON deal ko Lost nahi karta, aur paise ka hawala deta hai", () => {
    /* Won ke peechhe payment, invoice aur subscription lage hote hain. `stage-options.ts`
       ne isi wajah se `won` ko inline edit se bahar rakha tha. */
    const out = markLost("won");
    expect(out.nextStage).toBeNull();
    expect(out.reason).toMatch(/payment|invoice/i);
  });

  it("pehle se Lost par dobara nahi likhta", () => {
    expect(markLost("lost").nextStage).toBeNull();
  });
});

/* ══ FUNNEL KA KRAM ════════════════════════════════════════════════════════ */

describe("`code` — refusal jise UI padh sake, string match kiye bina", () => {
  it("aage badhne par 'moved'", () => {
    expect(advanceStage("new", "contact").code).toBe("moved");
    expect(markLost("new").code).toBe("moved");
  });

  it("pehle se wahan / usse aage hone par 'already'", () => {
    /* Yahi wo ek refusal hai jise UI CHUP-CHAAP jaane deta hai. Contacted lead ko dobara
       call karna roz ka kaam hai; uspar har baar "stage nahi badla" chipkana shor hai.
       Baaki har refusal user ko dikhni chahiye. */
    expect(advanceStage("contact", "contact").code).toBe("already");
    expect(advanceStage("quote", "contact").code).toBe("already");
    expect(markLost("lost").code).toBe("already");
  });

  it("won/lost par 'terminal' — ye chupani nahi hai", () => {
    expect(advanceStage("won", "contact").code).toBe("terminal");
    expect(advanceStage("lost", "contact").code).toBe("terminal");
    expect(markLost("won").code).toBe("terminal");
  });

  it("anjaan ya gायab stage apne alag code lauta te hain", () => {
    expect(advanceStage("negotiation", "quote").code).toBe("unknown");
    expect(advanceStage(null, "contact").code).toBe("nostage");
  });
});

describe("FUNNEL_ORDER", () => {
  it("me won/lost nahi hain — wo terminal hain, funnel ke kadam nahi", () => {
    expect(FUNNEL_ORDER).not.toContain("won");
    expect(FUNNEL_ORDER).not.toContain("lost");
  });

  it("quote ko AAKHIR me rakhta hai, jaisa chalta hua auto-stage code maanta hai", () => {
    /* Ye asahmati asli hai aur chupayi nahi ja rahi: `stage-options.ts` quote ko pehle
       rakhta hai (uska PRE_QUOTE = new/contact/lost). `pipelines.ts:35` aur
       `stage-after-quote-sent.ts:36` dono aakhir me rakhte hain. Yahan bahumat liya gaya
       hai. Jis din tay ho ki sach kya hai, ye test hi wo jagah hai jahan se badlega. */
    expect(FUNNEL_ORDER[FUNNEL_ORDER.length - 1]).toBe("quote");
  });
});
