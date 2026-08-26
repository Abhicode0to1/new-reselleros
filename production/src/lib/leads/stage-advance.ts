/**
 * Ek hi jagah jo tay karti hai ki koi action lead ka stage aage badha sakta hai ya nahi.
 *
 * ─── YE FILE KYUN BANI ──────────────────────────────────────────────────────
 * 26 Aug 2026: Pardeep ne stage ka manual dropdown hatane ko kaha — stage sirf us baat se
 * badle jo lead ke saath sach me hui. Us se pehle stage do jagah se apne aap badalta tha
 * (`stage-after-quote-sent.ts` aur `swipe-gesture.ts`), aur dono ne apna-apna forward-only
 * guard likha tha. Teesri copy likhne ke bajaye niyam yahan aa gaya.
 *
 * ─── FORWARD ONLY, AUR YAHI POORA KHATRA HAI ───────────────────────────────
 * `stage` teen jagah load-bearing hai: `heat.ts` ka intentTier(), `heat-score.ts` ka funnel
 * progress, aur Deals pipeline ki ginti. Ek peechhe ka move board, stage-age badge aur
 * forecast — teeno ko galat kar deta hai. Isliye har inkaar neeche ek peechhe ka move hai.
 *
 * ─── FUNNEL KA KRAM: DO FILE AAPAS ME AASAHMAT HAIN ────────────────────────
 * `pipelines.ts:35` aur `stage-after-quote-sent.ts:36` dono `quote` ko AAKHIR me rakhte hain
 * (new → contact → demo → trial → quote). `stage-options.ts` usse pehle rakhta hai — uska
 * PRE_QUOTE = new/contact/lost hai, yaani quote inbox se nikalne ka darwaza.
 *
 * Yahan bahumat maana gaya hai (quote aakhir me), kyunki chalta hua auto-stage code wahi
 * maanta hai. Ye asahmati chupayi nahi ja rahi — jab tay ho jaye ki sach kya hai, dono
 * jagah ek saath theek karni hongi. Tab tak yahi ek jagah hai jise badalna padega.
 */
import type { Lead } from "@/lib/supabase/database.types";

export type Stage = Lead["stage"];

/** Funnel ka kram. `won` aur `lost` terminal hain, isliye jaan-boojh kar isme nahi. */
export const FUNNEL_ORDER = ["new", "contact", "demo", "trial", "quote"] as const;

/**
 * Kyun nahi hila — machine ke padhne layak.
 *
 * `reason` insaan ke liye hai; ispar UI faisla nahi le sakta bina string match kiye, jo
 * pehli hi bhasha badalne par toot jata. Ye field isliye aaya (26 Aug 2026) ki ek
 * refusal aur baaki refusals me farak hai:
 *
 *   `already` — lead pehle hi us stage par ya usse aage hai. Ye AAM haalat hai. Contacted
 *               lead ko dobara call karna roz hota hai; uspar har baar "stage nahi badla"
 *               ka sandesh dikhana shor hai, khabar nahi.
 *
 *   baaki sab — kuch aisa hua jo user ne socha nahi tha (Won/Lost, ya anjaan stage). Wo
 *               dikhna chahiye.
 */
export type StageRefusal = "moved" | "already" | "terminal" | "unknown" | "nostage";

export interface StageAdvance {
  /** Likhne wala stage, ya null agar chhod dena hai. */
  nextStage: Stage | null;
  /** Hamesha maujood — caller ise log karta hai, taaki "kuch nahi hua" bhi samjha ja sake. */
  reason: string;
  /** Faisla lene ke liye — `reason` ka string match karne ke bajaye. */
  code: StageRefusal;
}

function rank(stage: string): number {
  return (FUNNEL_ORDER as readonly string[]).indexOf(stage);
}

/**
 * Kya `target` par jaana ek aage ka kadam hai?
 *
 * Har wo haalat jisme jawab "nahi" hai, apni wajah ke saath lautti hai — kyunki "kuch nahi
 * hua" aur "hone nahi diya gaya" do alag baatein hain, aur user ko doosri wali dikhni
 * chahiye (CLAUDE.md §24).
 */
export function advanceStage(
  currentStage: string | null | undefined,
  target: (typeof FUNNEL_ORDER)[number],
): StageAdvance {
  const stage = (currentStage ?? "").trim().toLowerCase();

  if (!stage) {
    /* Bina stage ki lead ko hum samajhte nahi. Ek event se uski funnel jagah gadhna
       andaza hoga, jaanch nahi. */
    return { nextStage: null, code: "nostage", reason: "is lead ka koi stage darj nahi hai, isliye kuch nahi badla" };
  }

  if (stage === "won") {
    /* Jeete hue deal ko wapas pipeline me kheenchna use forecast me do baar ginega aur
       uski stage-age dobara shuru kar dega. */
    return { nextStage: null, code: "terminal", reason: "deal pehle hi Won hai — use wapas pipeline me nahi laya jata" };
  }

  if (stage === "lost") {
    /* Kisi ne ise Lost kaha tha. Ek nayi baat-cheet us faisle ka palatna nahi hai —
       reopen wahi kare jisne band kiya tha. */
    return {
      nextStage: null,
      code: "terminal",
      reason: "lead Lost hai — use dobara kholna ek insaan ka faisla hai, kisi action ka side effect nahi",
    };
  }

  const from = rank(stage);
  const to   = rank(target);

  if (from < 0) {
    /* DB me aisa stage jo is list me nahi. Chhoda ja raha hai AUR bola ja raha hai —
       galat aage ka move utna hi nuksaandeh hai jitna galat peechhe ka, aur koi bhi naya
       stage isi shakha me girega. */
    return { nextStage: null, code: "unknown", reason: `stage "${stage}" is niyam ko pata nahi hai, isliye chhod diya gaya` };
  }

  if (from >= to) {
    return {
      nextStage: null,
      code: "already",
      reason: from === to
        ? `lead pehle se ${stage} par hai`
        : `lead ${stage} par hai, jo ${target} se aage hai — peechhe nahi le jaya jata`,
    };
  }

  return { nextStage: target, code: "moved", reason: `${stage} se ${target} par aaya` };
}

/**
 * Lost alag hai, aur jaan-boojh kar `advanceStage` se bahar hai.
 *
 * Lost funnel me "aage" nahi hai — wo baahar nikalna hai, aur wo kisi bhi jagah se ho sakta
 * hai. Ek hi rok: jeeta hua deal chip se Lost nahi hota. Uske peechhe paisa, invoice aur
 * subscription lage hote hain, aur unhe ek tap se palatna wahi galti hai jise
 * `stage-options.ts` ne `won` ko inline edit se bahar rakh kar roka tha.
 */
export function markLost(currentStage: string | null | undefined): StageAdvance {
  const stage = (currentStage ?? "").trim().toLowerCase();

  if (stage === "won") {
    return {
      nextStage: null,
      code: "terminal",
      reason: "Won deal ko Lost nahi kiya ja sakta — uske peechhe payment aur invoice hai, wo alag faisla hai",
    };
  }
  if (stage === "lost") {
    return { nextStage: null, code: "already", reason: "lead pehle se Lost hai" };
  }
  return { nextStage: "lost", code: "moved", reason: `${stage || "lead"} se Lost par gaya` };
}
