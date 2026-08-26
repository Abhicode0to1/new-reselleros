/**
 * "Ye lead kitni der se jawab ka intezaar kar rahi hai."
 *
 * ─── YE FILE KYUN BANI ──────────────────────────────────────────────────────
 * 26 Aug 2026: Pardeep ne kaha lead page ko duniya ke sabse achhe lead pages ki research
 * se behtar karo. Research me sabse zyada citation wali baat lead management ki hai, aur
 * wo table ke bare me nahi hai — wo WAQT ke bare me hai (MIT / InsideSales, 15,000 leads,
 * 100,000 call attempts):
 *
 *   · 5 minute me jawab dene par lead qualify hone ki sambhavna 30 minute se 21 GUNA
 *   · 78% B2B customer us vendor se khareedte hain jo PEHLE jawab deta hai
 *   · Industry ka average jawab 42 GHANTE hai
 *
 * Us se pehle is page par jawab ka waqt kahin nahi dikhta tha. `follow_up_date` dikhti
 * thi — yaani "agli baat kab karni hai" — par "ye lead kab se ruki hai" nahi. Dono ek
 * jaise lagte hain aur ek jaise hain nahi: pehli ek yojana hai, doosri ek karz.
 *
 * ─── DATA PEHLE SE MAUJOOD HAI ──────────────────────────────────────────────
 * Usi din maine pehle daawa kiya tha ki iske liye `leads.first_responded_at` column
 * banana padega, "warna ye waqt hamesha ke liye kho jayega". Wo GALAT tha, aur query
 * chalakar galat sabit hua: `lead_activities` har outbound touch ko timestamptz ke saath
 * likhti hai. Chaudai `min(created_at)` se nikal aati hai — koi migration nahi.
 *
 * ─── DO ALAG CHEEZEIN, EK COLUMN ────────────────────────────────────────────
 * `answered` ek RECORD hai (kitni der lagi — beeti baat, alarm nahi).
 * `waiting`  ek KARZ hai (kitni der se ruki hai — aaj ka kaam).
 * Inhe ek jaisa dikhana wahi galti hoti jo `follow_up_date` ke saath hui thi.
 */

/** Wo activity kinds jo "hum ne jawab diya" ginte hain. `note` isme NAHI hai. */
export const OUTBOUND_KINDS = ["email", "email_out", "call", "whatsapp", "quote"] as const;

export type WaitBand = "fresh" | "slipping" | "late" | "cold";

export type WaitState =
  /** Hum ne jawab de diya — kitni der me. */
  | { kind: "answered"; minutes: number }
  /** Jawab abhi tak nahi gaya — kitni der se ruki hai. */
  | { kind: "waiting"; minutes: number; band: WaitBand }
  /** Lead ka aane ka waqt hi darj nahi — andaza nahi lagate. */
  | { kind: "unknown" };

/* ── Bands, seedhe us study ke maapdand se ─────────────────────────────────
   5 aur 30 minute study ke apne do bindu hain (unka "21 guna" inhi ke beech ka hai), to
   pehli do hadd wahi hain. 24 ghanta uske baad ka sabse imaandar bindu hai: usse aage
   "kitne ghante" ginna bemani ho jata hai — 40 ghante aur 60 ghante me farak wo nahi jo
   6 minute aur 40 minute me hai. */
const FRESH_MAX_MIN    = 5;
const SLIPPING_MAX_MIN = 30;
const LATE_MAX_MIN     = 24 * 60;

export function waitBand(minutes: number): WaitBand {
  if (minutes <= FRESH_MAX_MIN)    return "fresh";
  if (minutes <= SLIPPING_MAX_MIN) return "slipping";
  if (minutes <= LATE_MAX_MIN)     return "late";
  return "cold";
}

function minutesBetween(from: string, to: Date): number | null {
  const t = new Date(from).getTime();
  if (Number.isNaN(t)) return null;
  /* `max(0, …)` — ghadi ka farak ya thoda peeche ka timestamp rinatmak intezaar bana
     deta hai, aur "-3 minute se ruki hai" ek bug jaisa padhta hai. */
  return Math.max(0, Math.floor((to.getTime() - t) / 60_000));
}

/**
 * @param createdAt    Lead kab aayi.
 * @param firstReplyAt Hamara pehla outbound touch, ya null agar koi nahi.
 */
export function waitState(
  createdAt: string | null | undefined,
  firstReplyAt: string | null | undefined,
  now: Date = new Date(),
): WaitState {
  if (!createdAt) return { kind: "unknown" };
  const arrived = new Date(createdAt).getTime();
  if (Number.isNaN(arrived)) return { kind: "unknown" };

  if (firstReplyAt) {
    const replied = new Date(firstReplyAt).getTime();
    if (Number.isNaN(replied)) return { kind: "unknown" };
    return { kind: "answered", minutes: Math.max(0, Math.floor((replied - arrived) / 60_000)) };
  }

  const waited = minutesBetween(createdAt, now);
  if (waited == null) return { kind: "unknown" };
  return { kind: "waiting", minutes: waited, band: waitBand(waited) };
}

/**
 * Chhota label — "4m", "3h", "2d".
 *
 * Ghante ke aage minute nahi dikhate: "3h 47m" ek table cell me do baar padhna padta hai
 * aur us 47 se koi faisla nahi badalta.
 */
export function waitLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (24 * 60))}d`;
}

/**
 * Row ka sort vazan — "jise action chahiye pehle".
 *
 * Bada number = pehle. Research kehti hai default order me wo cheez pehle honi chahiye
 * jispar kaam baaki hai, na ki jo sabse nayi hai — aur `created` par sort karne se ek
 * teen din se ruki hui lead teesre panne par chali jati thi.
 *
 * Jo lead ruki hui hai wo HAR jawab-de-di-gayi lead se upar aati hai, chahe wo 1 minute
 * se ruki ho: intezaar khatm karna ek kaam hai, beeta hua waqt ek record.
 */
export function waitPriority(s: WaitState): number {
  if (s.kind === "waiting") return 1_000_000 + s.minutes;
  if (s.kind === "answered") return s.minutes;      // dher waqt lagne wali pehle
  return -1;                                        // unknown sabse aakhir
}
