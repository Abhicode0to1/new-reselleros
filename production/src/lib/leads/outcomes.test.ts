import { describe, it, expect } from "vitest";
import { applyOutcome, tomorrowISO, localDateISO, OUTCOME_CHIPS, chipsForStage } from "./outcomes";
import type { Lead } from "@/lib/supabase/database.types";

const lead = (over: Partial<Lead> = {}) =>
  ({ company: "Bright Systems", contact_phone: "+91 98111 22233", follow_up_date: null,
     stage: "new", ...over }) as Lead;

describe("localDateISO / tomorrowISO — the IST off-by-one-day trap", () => {
  it("formats from LOCAL parts, so an early-morning tap books the right day", () => {
    /* The bug this avoids: at 02:00 IST, new Date().toISOString().slice(0,10) is
       YESTERDAY, because IST is UTC+5:30. A rep tapping "Call tomorrow" at 7am would
       book the call for today. */
    const earlyMorning = new Date(2026, 7, 14, 2, 0, 0);       // 14 Aug 2026, 02:00 local
    expect(localDateISO(earlyMorning)).toBe("2026-08-14");
    expect(tomorrowISO(earlyMorning)).toBe("2026-08-15");
  });

  it("rolls over a month end", () => {
    expect(tomorrowISO(new Date(2026, 7, 31, 23, 30))).toBe("2026-09-01");
  });

  it("rolls over a year end", () => {
    expect(tomorrowISO(new Date(2026, 11, 31, 9, 0))).toBe("2027-01-01");
  });

  it("handles a leap day", () => {
    expect(tomorrowISO(new Date(2028, 1, 28, 9, 0))).toBe("2028-02-29");
    expect(tomorrowISO(new Date(2028, 1, 29, 9, 0))).toBe("2028-03-01");
  });

  it("zero-pads single-digit months and days", () => {
    expect(localDateISO(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

const NOW = new Date(2026, 7, 14, 11, 0);      // 14 Aug 2026, 11:00 local
const TOMORROW = "2026-08-15";

describe("no chip EVER puts stage in the patch", () => {
  it("is true for every chip, by construction", () => {
    /* ─── YE IS FILE KI SABSE ZAROORI ASSERTION HAI ─────────────────────────
       26 Aug 2026 tak ye test "koi chip stage badalta hi nahi" kehta tha. Ab kuch chip
       badalte hain — par HAMESHA `useChangeLeadStage` se guzar kar, kabhi `patch` se.

       Farq bahut bada hai: wo hook `lost` par loss-reason poochhta hai aur reason na
       milne par move CANCEL kar deta hai. `patch.stage` likhne wala ek chip us guard ko
       chup-chaap bypass kar dega — aur bina wajah wala Lost theek wahi cheez hai jise
       rokne ke liye wo feature bana tha.

       Isliye ye test ab bhi utna hi sakht hai, bas ab wo galat DARWAZE ko pakadta hai. */
    for (const chip of OUTCOME_CHIPS) {
      const eff = applyOutcome(chip.id, lead(), NOW);
      expect(eff.patch ?? {}).not.toHaveProperty("stage");
    }
  });

  it("chips jo stage ko chhoona hi nahi chahiye, unka faisla null hai", () => {
    /* `send_quote` aur `no_answer` ki wajah outcomes.ts ke header me likhi hai:
       quote-stage tab banta hai jab quote row bane, aur bina uthi call sampark nahi hai. */
    for (const id of ["no_answer", "call_tomorrow", "send_quote", "mark_junk"] as const) {
      expect(applyOutcome(id, lead(), NOW).stage).toBeNull();
    }
  });
});

describe("Baat hui — wo chip jiski gairhaazri me dropdown zinda tha", () => {
  it("new lead ko contact par le jata hai", () => {
    const eff = applyOutcome("talked", lead({ stage: "new" }), NOW);
    expect(eff.stage?.nextStage).toBe("contact");
  });

  it("follow-up date ko haath nahi lagata", () => {
    /* Baat ho jaana ye nahi batata ki agli baat kab karni hai. Ise tomorrow par set karna
       rep ke faisle ke upar likhna hota. */
    const eff = applyOutcome("talked", lead({ follow_up_date: "2026-09-01" }), NOW);
    expect(eff.patch).toBeNull();
  });

  it("aage badhi hui lead ko PEECHHE nahi kheenchta", () => {
    /* Poora khatra yahi hai: stage heat.ts, heat-score.ts aur Deals pipeline teeno padhte
       hain. Quote bhej chuki lead par "baat hui" tap karna use wapas contact par nahi
       laa sakta. */
    const eff = applyOutcome("talked", lead({ stage: "quote" }), NOW);
    expect(eff.stage?.nextStage).toBeNull();
    expect(eff.stage?.reason).toMatch(/peechhe/);
  });

  it("won aur lost dono ko chhodta hai, aur wajah batata hai", () => {
    for (const stage of ["won", "lost"] as const) {
      const eff = applyOutcome("talked", lead({ stage }), NOW);
      expect(eff.stage?.nextStage).toBeNull();
      expect(eff.stage?.reason).toBeTruthy();
    }
  });
});

describe("jo baat hui, wo call ke SAATH record hoti hai", () => {
  /* Pardeep, 26 Aug 2026: "maine lead se phone par baat ki aur jo baat hui wo kahan
     record hogi". Pehle do alag kaam the — note Save karo, phir "Baat hui" dabao — aur
     timeline me do tukde bante the, jinme baat ka mazmoon us call se juda hi nahi hota. */

  it("note ko usi call ki detail me jodta hai", () => {
    const eff = applyOutcome("talked", lead(), NOW, "20 seats chahiye, budget March me");
    expect(eff.activity?.kind).toBe("call");
    expect(eff.activity?.detail).toContain("+91 98111 22233");
    expect(eff.activity?.detail).toContain("20 seats chahiye, budget March me");
  });

  it("No answer par bhi chalta hai — 'ring hui, uthi nahi' bhi ek baat hai", () => {
    const eff = applyOutcome("no_answer", lead(), NOW, "receptionist ne kaha kal try karein");
    expect(eff.activity?.detail).toContain("receptionist ne kaha kal try karein");
  });

  it("aadmi ke likhe hisse ko quotes me rakhta hai", () => {
    /* Timeline baad me koi aur padhega. Quotes ke bina wo nahi bata sakti ki kaun sa
       lafz customer ka tha aur kaun sa app ka. */
    const eff = applyOutcome("talked", lead(), NOW, "March me budget aayega");
    expect(eff.activity?.detail).toMatch(/· "March me budget aayega"$/);
  });

  it("No answer par do dash nahi banata", () => {
    /* Uski apni detail "— retrying tomorrow" par khatam hoti hai. Note ko bhi `—` se
       jodne par "— retrying tomorrow — 20 seats chahiye" ban jata tha. */
    const eff = applyOutcome("no_answer", lead(), NOW, "kal subah try karein");
    expect(eff.activity?.detail).not.toMatch(/—[^—]*—/);
  });

  it("khaali note par detail waisi hi rehti hai — koi latakta hua separator nahi", () => {
    /* Row ke chips 1-tap hain aur note nahi bhejte. Un par "Baat hui · +91… · """
       chhapna ek adhoora record dikhta. */
    for (const note of ["", "   ", undefined]) {
      const eff = applyOutcome("talked", lead(), NOW, note);
      expect(eff.activity?.detail).not.toMatch(/[·—]\s*"?\s*$/);
    }
  });

  it("stage ka faisla note se nahi badalta", () => {
    /* Note sirf mazmoon hai. Agar wo forward-only niyam ko hila sakta, to ek likhi hui
       line pipeline ko peechhe le ja sakti thi. */
    const withNote = applyOutcome("talked", lead({ stage: "quote" }), NOW, "kuch bhi");
    expect(withNote.stage?.nextStage).toBeNull();
  });
});

describe("Lost — jo funnel me aage nahi, baahar hai", () => {
  it("kisi bhi khule stage se Lost par le jata hai", () => {
    for (const stage of ["new", "contact", "demo", "trial", "quote"] as const) {
      expect(applyOutcome("mark_lost", lead({ stage }), NOW).stage?.nextStage).toBe("lost");
    }
  });

  it("WON deal ko ek tap se Lost nahi karta", () => {
    /* Won ke peechhe payment, invoice aur subscription lage hote hain. Ise ek chip se
       palatna wahi galti hai jise stage-options.ts ne `won` ko inline edit se bahar
       rakh kar roka tha. */
    const eff = applyOutcome("mark_lost", lead({ stage: "won" }), NOW);
    expect(eff.stage?.nextStage).toBeNull();
    expect(eff.stage?.reason).toMatch(/payment|invoice/i);
  });
});

describe("chipsForStage — chip wahin dikhe jahan wo agla kadam hai", () => {
  it("naye lead par 'Baat hui' hai, par 'Trial shuru' nahi", () => {
    const ids = chipsForStage("new").map((c) => c.id);
    expect(ids).toContain("talked");
    expect(ids).not.toContain("trial_started");
  });

  it("HAR khule stage par 'Baat hui' milta hai, sirf naye par nahi", () => {
    /* ─── Wo chhed jo Pardeep ne pakda (26 Aug 2026) ──────────────────────────
       Pehle `talked` sirf `new` par dikhta tha, is soch se ki "sampark ho chuka, ab
       kya dobara contact karna". Uska nateeja ye tha ki Contacted lead ke row menu me
       call darj karne ka koi raasta hi nahi bachta — Pardeep ka sawaal seedha yahi tha:
       "phone par hogi to usko kaise record karenge".

       Galti ek hi cheez me do baatein milane ki thi: "call hui" aur "stage aage badhao".
       Call har stage par hoti hai; stage sirf PEHLI baar aage badhta hai, aur usse
       forward-only niyam apne aap sambhal leta hai. */
    for (const s of ["new", "contact", "demo", "trial", "quote"] as const) {
      expect(chipsForStage(s).map((c) => c.id), `${s} par talked chahiye`).toContain("talked");
    }
  });

  it("won lead par koi stage-badalne wala chip nahi bachta", () => {
    /* Jeeti hui deal par har aisa chip ek peechhe ka move hoga, aur niyam use waise bhi
       mana kar dega — use dikhana sirf ek aisa button hai jo kuch nahi karta. */
    const ids = chipsForStage("won").map((c) => c.id);
    for (const gone of ["talked", "demo_done", "trial_started", "mark_lost"]) {
      expect(ids).not.toContain(gone);
    }
  });
});

describe("applyOutcome — No answer", () => {
  const eff = applyOutcome("no_answer", lead(), NOW);

  it("brings the lead back tomorrow", () => {
    expect(eff.patch).toEqual({ follow_up_date: TOMORROW });
  });

  it("logs it as an ATTEMPT, not as contact", () => {
    // "We contacted 40 leads this week" must not count phones that rang out.
    expect(eff.activity?.kind).toBe("call");
    expect(eff.activity?.detail).toMatch(/No answer/);
    expect(eff.activity?.detail).not.toMatch(/contacted/i);
  });

  it("records the number dialled, so the log survives a later edit", () => {
    expect(eff.activity?.detail).toContain("+91 98111 22233");
  });

  it("still works with no phone on record", () => {
    const e = applyOutcome("no_answer", lead({ contact_phone: null }), NOW);
    expect(e.activity?.detail).toBe("No answer — retrying tomorrow");
    expect(e.patch).toEqual({ follow_up_date: TOMORROW });
  });

  it("names the company in the confirmation", () => {
    expect(eff.toast).toContain("Bright Systems");
    expect(eff.undoable).toBe(true);
  });
});

describe("applyOutcome — Call tomorrow", () => {
  it("sets tomorrow", () => {
    expect(applyOutcome("call_tomorrow", lead(), NOW).patch).toEqual({ follow_up_date: TOMORROW });
  });

  it("overrides a follow-up already set FURTHER OUT", () => {
    /* The rep just said "tomorrow". Keeping next Friday because it is further away
       would silently override the person holding the phone. */
    const e = applyOutcome("call_tomorrow", lead({ follow_up_date: "2026-09-30" }), NOW);
    expect(e.patch).toEqual({ follow_up_date: TOMORROW });
  });

  it("overrides an overdue follow-up too", () => {
    const e = applyOutcome("call_tomorrow", lead({ follow_up_date: "2026-01-01" }), NOW);
    expect(e.patch).toEqual({ follow_up_date: TOMORROW });
  });
});

describe("applyOutcome — Send quote", () => {
  const eff = applyOutcome("send_quote", lead(), NOW);

  it("navigates and writes NOTHING", () => {
    expect(eff.navigate).toBe("quote");
    expect(eff.patch).toBeNull();
  });

  it("does not set stage to 'quote' — the quote does not exist yet", () => {
    // The single most important assertion in this file.
    expect(eff.stage).toBeNull();
    expect(JSON.stringify(eff)).not.toMatch(/"stage"\s*:\s*"quote"/);
  });

  it("logs no activity — opening a builder is not an event worth a row", () => {
    expect(eff.activity).toBeNull();
    expect(eff.toast).toBe("");
  });
});

describe("applyOutcome — Mark junk", () => {
  const eff = applyOutcome("mark_junk", lead(), NOW);

  it("sets is_junk and nothing else", () => {
    expect(eff.patch).toEqual({ is_junk: true });
  });

  it("is undoable, because a mis-tap on a real lead must be recoverable", () => {
    expect(eff.undoable).toBe(true);
  });

  it("leaves the follow-up date alone — the lead is hidden, not rescheduled", () => {
    expect(eff.patch).not.toHaveProperty("follow_up_date");
  });
});

describe("OUTCOME_CHIPS — the shared vocabulary", () => {
  it("has the eight chips the funnel needs, in tap order", () => {
    /* 26 Aug 2026 tak yahan chaar the. Chaar isliye kam pade ki unme se EK BHI "insaan se
       baat ho gayi" nahi kehta tha — isliye desktop par stage aage badhane ka ekmatra
       raasta dropdown reh gaya tha, jise Pardeep hataana chahta tha.

       Ye list jaan-boojh kar sakht hai: chip jodna ek pipeline ka faisla hai, aur ye test
       use dikhaye bina nikalne nahi deta. */
    expect(OUTCOME_CHIPS.map((c) => c.id)).toEqual([
      "talked", "no_answer", "call_tomorrow", "demo_done",
      "trial_started", "send_quote", "mark_lost", "mark_junk",
    ]);
  });

  it("EK naam har jagah — button, toast, aur record me koi doosra shabd nahi", () => {
    /* 26 Aug 2026: label "Baat hui" se "Call log" hua, kyunki drawer aur row ka menu do
       alag naam dikha rahe the — ek kaam, do naam.

       Par activity ki detail nahi badli, aur wo jaan-boojh kar hai: timeline me uska
       jodidaar "No answer" hai, aur dono batate hain ki call me KYA HUA. Wahan "Call log"
       likhna us farak ko mita deta, kyunki dono hi call log hain. Button ek KAAM ka naam
       hai, record ek NATEEJE ka.

       Ye test us farak ko pin karta hai — warna agli safai me koi dono ko "ek jaisa" kar
       dega aur timeline apni sabse kaam ki baat kho degi. */
    const chip = OUTCOME_CHIPS.find((c) => c.id === "talked");
    const eff = applyOutcome("talked", lead(), NOW);
    expect(chip?.label).toBe("Call log");
    /* Kahin bhi "Baat hui" nahi bacha — na toast me, na record me. */
    expect(eff.toast).not.toMatch(/baat hui/i);
    expect(eff.activity?.detail).not.toMatch(/baat hui/i);
    /* Aur record me "Call log" bhi NAHI: timeline ka title pehle se "Call logged" hai,
       to detail me wahi shabd dohrana ek hi baat do baar likhna hai. */
    expect(eff.activity?.detail).not.toMatch(/call log/i);
  });

  it("stage ko chhune wala koi chip Won/Lost par nahi dikhta", () => {
    /* `showsAt: null` matlab "hamesha dikhao". Wo sirf un chips par theek hai jo stage ko
       chhute hi nahi. `talked` aur `no_answer` har KHULE stage par dikhte hain par
       terminal par nahi — warna Won deal par har call log karne ke saath "deal pehle hi
       Won hai" ka bekaar sandesh aata, jo khabar nahi shor hai. */
    for (const c of OUTCOME_CHIPS) {
      if (["talked", "no_answer", "demo_done", "trial_started", "mark_lost"].includes(c.id)) {
        expect(c.showsAt, `${c.id} ko showsAt chahiye`).not.toBeNull();
        expect(c.showsAt, `${c.id} won par nahi`).not.toContain("won");
        expect(c.showsAt, `${c.id} lost par nahi`).not.toContain("lost");
      }
    }
  });

  it("every chip explains itself — no mystery buttons (§24)", () => {
    for (const c of OUTCOME_CHIPS) {
      expect(c.hint.length).toBeGreaterThan(20);
      expect(c.label.length).toBeGreaterThan(0);
    }
  });

  it("the two chips whose stage behaviour surprises people SAY so in the hint", () => {
    const byId = Object.fromEntries(OUTCOME_CHIPS.map((c) => [c.id, c]));
    expect(byId.no_answer.hint).toMatch(/not changed|not contact/i);
    expect(byId.send_quote.hint).toMatch(/stage moves when/i);
  });

  it("marks which chip needs a phone number", () => {
    const byId = Object.fromEntries(OUTCOME_CHIPS.map((c) => [c.id, c]));
    expect(byId.no_answer.needsPhone).toBe(true);
    expect(byId.mark_junk.needsPhone).toBe(false);
  });
});
