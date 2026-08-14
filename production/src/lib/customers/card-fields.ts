/**
 * Turning what an AI read off a visiting card (or an email signature) into
 * values the customer form can safely hold.
 *
 * ─── EVERY FIELD HERE IS A SUGGESTION, AND SOME ARE REFUSED OUTRIGHT ────────
 * OCR misreads characters. That is fine for a company name — the operator sees
 * "Acmc Corp" and fixes it. It is NOT fine for fields the books depend on, so
 * this module drops a value rather than pass on a plausible wrong one:
 *
 *   · GSTIN is accepted ONLY if it passes the real checksum (isValidGstin). A
 *     GSTIN with one misread character looks completely normal and would put a
 *     wrong tax identity on every invoice to that customer. Better blank.
 *   · state / state_code are NEVER taken from a card, even when the address
 *     names a city. In India the state decides CGST+SGST versus IGST, so a
 *     guessed state silently produces the wrong tax split. Those come from the
 *     GSTIN verification the form already does, which is a government source.
 *   · A phone becomes +91XXXXXXXXXX or nothing. A half-normalised number is
 *     worse than an empty box because it looks finished.
 *
 * Pure and dependency-light so all of this is provable without a model, a
 * network call, or a form.
 */
import { isValidGstin } from "@/lib/utils";

/** The raw shape the model is asked to return. Every field may be missing. */
export interface ScannedCard {
  company_name?:  unknown;
  contact_name?:  unknown;
  designation?:   unknown;
  email?:         unknown;
  phone?:         unknown;
  mobile?:        unknown;
  address?:       unknown;
  city?:          unknown;
  pin_code?:      unknown;
  domain?:        unknown;
  gstin?:         unknown;
}

/** What the form may safely be pre-filled with. Anything unusable is null. */
export interface CardFields {
  name:          string | null;
  contact_name:  string | null;
  contact_title: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contact_mobile: string | null;
  address:       string | null;
  city:          string | null;
  pin_code:      string | null;
  domain:        string | null;
  gstin:         string | null;
}

const text = (v: unknown, max = 200): string | null => {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  return s ? s.slice(0, max) : null;
};

/**
 * An Indian mobile/landline in E.164, or null.
 *
 * Accepts the shapes a card actually carries — `+91 98765 43210`,
 * `098765 43210`, `91-9876543210`, `9876543210` — and refuses anything that is
 * not a plausible Indian 10-digit number starting 6-9. A partly-cleaned number
 * is not returned: an operator trusts a filled box.
 */
export function toIndianE164(raw: unknown): string | null {
  const digits = (typeof raw === "string" ? raw : "").replace(/\D/g, "");
  if (!digits) return null;

  let ten = digits;
  /* Peel the prefixes in the order they nest, rather than matching each whole
     shape by length. A first attempt special-cased "0091…" as 13 digits — it is
     14, so that case silently fell through and returned null. Peeling is both
     shorter and has no lengths to get wrong. */
  if (ten.startsWith("00")) ten = ten.slice(2);              // 00 = intl access code
  if (ten.length === 12 && ten.startsWith("91")) ten = ten.slice(2);
  else if (ten.length === 11 && ten.startsWith("0")) ten = ten.slice(1);   // STD trunk 0

  if (ten.length !== 10 || !/^[6-9]/.test(ten)) return null;
  return `+91${ten}`;
}

/** A lower-cased address, or null. Deliberately strict — a typo'd email is worse
 *  than an empty field, because nobody re-reads a box that looks filled. */
export function cleanEmail(raw: unknown): string | null {
  const s = (typeof raw === "string" ? raw : "").trim().toLowerCase();
  if (!s) return null;
  // One @, something either side, a dot in the domain. Not RFC-complete on
  // purpose: this rejects OCR noise, it does not certify deliverability.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : null;
}

/** Bare domain: no scheme, no www., no path, lower-cased. */
export function cleanDomain(raw: unknown): string | null {
  let s = (typeof raw === "string" ? raw : "").trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split("/")[0].split("?")[0];
  // A card often prints the email where the website goes.
  if (s.includes("@")) s = s.split("@").pop() ?? "";
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
}

/** Six digits, and not starting with 0 — Indian PIN codes never do. */
export function cleanPin(raw: unknown): string | null {
  const d = (typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "").replace(/\D/g, "");
  return /^[1-9]\d{5}$/.test(d) ? d : null;
}

/**
 * A GSTIN only if it survives the checksum.
 *
 * This is the strictest rule in the file and the most important. OCR confuses
 * 0/O, 1/I, 5/S, 8/B constantly, and a GSTIN with one wrong character is
 * indistinguishable from a good one by eye — it would be carried onto every GST
 * invoice raised for that customer. The checksum catches almost all single
 * character errors, so anything that fails it is dropped and the operator types
 * it (and the form then verifies it against GSTN, which is the real source).
 */
export function cleanGstin(raw: unknown): string | null {
  const s = (typeof raw === "string" ? raw : "").replace(/\s/g, "").toUpperCase();
  if (s.length !== 15) return null;
  return isValidGstin(s) ? s : null;
}

/**
 * Map a model's reading of a card onto form fields.
 *
 * Note what is NOT returned: `state`, `state_code`, `country`, `group_id`,
 * `payment_terms_days`. The first two decide the GST tax split and must come
 * from the verified GSTIN, never from a card. The last two are commercial
 * decisions; a visiting card carries no evidence of company size or credit
 * terms, and pre-filling "Net 30" from nothing is a guess with money attached.
 */
export function mapScannedCard(ai: ScannedCard | null | undefined): CardFields {
  const a = ai ?? {};
  return {
    name:           text(a.company_name, 120),
    contact_name:   text(a.contact_name, 100),
    contact_title:  text(a.designation, 80),
    contact_email:  cleanEmail(a.email),
    contact_phone:  toIndianE164(a.phone),
    contact_mobile: toIndianE164(a.mobile),
    address:        text(a.address, 300),
    city:           text(a.city, 80),
    pin_code:       cleanPin(a.pin_code),
    domain:         cleanDomain(a.domain),
    gstin:          cleanGstin(a.gstin),
  };
}

/** How much of the form this actually filled — shown so the operator knows how
 *  much is still on them, rather than assuming the scan did everything. */
export function filledCount(f: CardFields): number {
  return Object.values(f).filter((v) => v !== null && v !== "").length;
}
