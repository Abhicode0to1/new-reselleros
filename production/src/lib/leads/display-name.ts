/**
 * Ek lead ko screen par kis naam se bulayein.
 *
 * ─── YE KYUN HAI ────────────────────────────────────────────────────────────
 * Pardeep, 29 Aug 2026: "kai baar contact ka naam to hota hai lekin company ka naam nahi
 * hota". Aur us soorat me leads table ka sabse zaroori column — jo batata hai ki row
 * KISKI hai — khaali reh jata tha.
 *
 * `leads.company` **NOT NULL** hai, isliye ye "null ho sakta hai" wali baat nahi lagti.
 * Par NOT NULL khaali string nahi rokta, aur enquiry form wala raasta theek wahi bharta
 * hai — `inbound-email/route.ts:130`:
 *
 *     company: (p.company ?? "").toString().trim()
 *
 * Jisne form me company nahi likhi, uski lead `company = ""` ke saath banti hai. Aaj DB
 * me aisi ek bhi row nahi hai (30 me se 0, naapa) — par ye us par nirbhar hai ki har
 * bharne wala company likhe, jo ek waada hai, ek pehra nahi.
 *
 * ─── JHOOTH NAHI BOLNA ──────────────────────────────────────────────────────
 * Aasan hal hota ki contact ka naam chup-chaap company ke khaane me chhap do. Wo galat
 * hota: "Raj Kumar" ko company ki tarah padha jayega, aur wahi naam quote aur invoice par
 * bhi jayega jahan wo ek company ka naam hona chahiye. Isliye ye function batata bhi hai
 * ki naam KAHAN se aaya — call site use alag dikha sake, aur us farq ko mita na de.
 */

export interface LeadNameParts {
  company?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
}

export type LeadNameSource = "company" | "contact" | "email" | "none";

export interface LeadDisplayName {
  /** Screen par jo chhapega. Kabhi khaali nahi hota. */
  label: string;
  /** Ye naam aaya kahan se. `company` ke alawa har cheez ek majboori hai, pehchan nahi. */
  source: LeadNameSource;
  /** Hover/screen-reader ke liye — kyun ye naam dikh raha hai. `company` par `null`. */
  hint: string | null;
}

const clean = (v: string | null | undefined): string => (typeof v === "string" ? v.trim() : "");

/** Jab kuch bhi na ho. Khaali cell aur "data hai par dikha nahi" grid me ek jaise lagte hain. */
const NAMELESS = "(no name)";

export function leadDisplayName(lead: LeadNameParts | null | undefined): LeadDisplayName {
  /* ── CONTACT pehle, company baad me (29 Aug 2026) ───────────────────────────
     Pardeep: "bina company ke lead ban sakti hai, par bina contact ke lead nahi ban
     sakti". Isliye row ki pehchan aadmi hai, company nahi — company ek vivaran hai jo
     baad me pata chalta hai.

     Ye pehle ulta tha, aur wo bhi soch kar hi tha; badla isliye ki business ki sachchai
     ulti hai. Jo cheez har lead par HOTI hai, wahi pehchan ban sakti hai — jo kabhi-kabhi
     khaali rehti hai wo nahi. */
  const contact = clean(lead?.contact_name);
  if (contact) return { label: contact, source: "contact", hint: null };

  const company = clean(lead?.company);
  if (company) {
    return {
      label: company,
      source: "company",
      hint: "Contact ka naam nahi diya gaya — ye company ka naam hai",
    };
  }

  /* Email tab bhi hota hai jab naam nahi hota — inbound wale raaste me wahi ek cheez
     pakki hai. Poora email dikhta hai, sirf uska pehla hissa nahi: do alag log ek hi
     domain se aa sakte hain, aur "raj" bनाम "raj" me farq nahi bachega. */
  const email = clean(lead?.contact_email);
  if (email) {
    return {
      label: email,
      source: "email",
      hint: "Na company ka naam hai na contact ka — ye email hai",
    };
  }

  return { label: NAMELESS, source: "none", hint: "Is lead par koi naam nahi hai" };
}

/**
 * Contact wale column me kya dikhe, jab naam pehle hi Company ke khaane me chala gaya ho.
 *
 * Bina iske wahi naam ek hi row me do baar chhapta — jo dekhne me galti lagti hai, aur us
 * jagah ko bhi kha jaati hai jiske liye ye poora badlav kiya gaya tha.
 */
export function leadContactLines(
  lead: LeadNameParts | null | undefined,
  shownAs: LeadNameSource,
): { name: string | null; email: string | null } {
  const name = clean(lead?.contact_name);
  const email = clean(lead?.contact_email);
  return {
    name: shownAs === "contact" || !name ? null : name,
    email: shownAs === "email" || !email ? null : email,
  };
}

/**
 * Company wale column me kya chhape.
 *
 * `null` tab jab company hai hi nahi, YA jab wo pehle hi pehchan bankar upar ja chuki ho
 * (contact ka naam nahi tha). Doosri soorat hi asli wajah hai: ek hi naam ek row me do
 * baar dikhna galti jaisa lagta hai, aur padhne wala rukkar sochta hai ki kya do alag
 * cheezein sanyog se ek jaisi hain.
 */
export function leadCompanyCell(
  lead: LeadNameParts | null | undefined,
  shownAs: LeadNameSource,
): string | null {
  const company = clean(lead?.company);
  return shownAs === "company" || !company ? null : company;
}
