/**
 * Pulling the customer's details out of an enquiry email.
 *
 * ─── WRITTEN RULES, NOT A MODEL ─────────────────────────────────────────────
 * The brief called this an "AI Entity Extractor". It is deliberately not one, for
 * the same reason the battlecards in lib/leads are written and not generated: a model
 * asked for a phone number will produce a plausible one. Every field here comes from
 * a rule that can be read, tested and pointed at, and every field that is not found
 * comes back NULL rather than filled in.
 *
 * That matters because these values pre-fill a lead and a quote. A hallucinated seat
 * count becomes a price; a hallucinated phone number becomes a WhatsApp message to a
 * stranger. A blank field costs a rep ten seconds of typing. They are not comparable
 * mistakes.
 *
 * ─── EVERY VALUE CARRIES WHERE IT CAME FROM ─────────────────────────────────
 * `source` is shown next to the value. A rep looking at "14 seats" needs to be able
 * to see it was read from "we need 14 seats" and not inferred from something else,
 * because they are the one who signs the quote.
 */

export interface Extracted<T> {
  value: T | null;
  /** The text this was read from — shown so a rep can check it. Null when nothing found. */
  source: string | null;
}

export interface CatalogueEntry {
  id:   string;
  name: string;
}

export interface ExtractedEntities {
  name:    Extracted<string>;
  email:   Extracted<string>;
  phone:   Extracted<string>;
  seats:   Extracted<number>;
  product: Extracted<CatalogueEntry>;
}

const NONE: Extracted<never> = { value: null, source: null };

/* ── Email ─────────────────────────────────────────────────────────────────── */

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/* ── Phone ─────────────────────────────────────────────────────────────────── */

/**
 * An Indian mobile: ten digits starting 6-9, optionally +91 / 0091 / 0 prefixed, and
 * optionally broken up by spaces or hyphens.
 *
 * The guards are the important part:
 *   • It must not be a slice of a LONGER digit run. A GSTIN, an order number and an
 *     amount are all long strings of digits with a valid-looking mobile inside them.
 *   • It must start 6-9. Indian mobiles do; years, quantities and pin codes do not.
 */
const PHONE_RE = /(?<![0-9])(?:(?:\+?91|0091|0)[\s-]*)?([6-9][0-9]{9})(?![0-9])/;

function digitsOnly(s: string): string {
  return s.replace(/[^0-9]/g, "");
}

function findPhone(text: string): Extracted<string> {
  /* Spaces and hyphens inside the number are stripped first so "98765 43210" is seen
     as one number — but only runs that look like a phone, so an amount like
     "24 000" is not glued into 24000 and then hunted for a mobile inside it. */
  const candidates = text.match(/(?:\+?91|0091)?[\s-]?[0-9][0-9\s-]{8,14}[0-9]/g) ?? [];
  for (const raw of candidates) {
    const compact = digitsOnly(raw);
    /* Strip a country/trunk prefix before testing the ten digits. */
    const local = compact.replace(/^(?:0091|91|0)(?=[6-9][0-9]{9}$)/, "");
    if (/^[6-9][0-9]{9}$/.test(local)) {
      return { value: local, source: raw.trim() };
    }
  }
  const direct = PHONE_RE.exec(text);
  return direct ? { value: direct[1], source: direct[0].trim() } : { ...NONE };
}

/* ── Seats ─────────────────────────────────────────────────────────────────── */

/**
 * A count only counts when it is next to a word meaning "seat".
 *
 * "14 August" and "₹14,000" are both a number in an enquiry and neither is a seat
 * count. Requiring the unit word is what keeps a date from becoming a quantity on a
 * quote.
 */
/**
 * ─── AND THE UNITS AN INDIAN RESELLER'S CUSTOMER ACTUALLY TYPES ─────────────
 * The live enquiry read "mujhe 20 email google workspace standard chahiye" and the panel
 * said SEATS: not found — so the quote button carried no seat count and whoever built that
 * quote typed a number from memory.
 *
 * Nobody in this market writes "20 seats". They write 20 email, 20 email id, 20 IDs,
 * 20 mailbox, 20 log (Hinglish for people). Those are the words, and a parser that knows
 * only the textbook ones is a parser for a different country.
 */
const SEAT_UNITS =
  "seats?|users?|licen[cs]es?|mailboxes|mailbox|accounts?|employees|staff|people" +
  /* E-mail as a COUNTABLE THING — "20 email", "20 emails", "20 email id", "20 mail". */
  String.raw`|e-?mails?(?:\s*ids?)?|mails?(?:\s*ids?)?` +
  /* "20 IDs" — everyday Indian usage for accounts. */
  "|ids?" +
  /* Hinglish for people: "20 log", "20 bande", "20 karmchari". */
  "|log|bande|banda|aadmi|karmchari";

/**
 * Verbs that turn a count of emails into a count of MESSAGES.
 *
 * "I sent you 20 emails" and "we received 20 mails" are the one real cost of accepting
 * "email" as a seat unit, and they are cheap to exclude: the giveaway is always a sending
 * or receiving verb immediately before the number. Without this guard, a complaint about
 * unanswered mail becomes a 20-seat quote.
 */
const NOT_A_COUNT_BEFORE =
  "sent|send|sending|receiv(?:e|ed)|got|reply|replied|forward(?:ed)?|attach(?:ed)?";

const SEATS_RE = new RegExp(
  /* The lookbehind allows up to two words between the verb and the number, because the
     real sentences are "I sent YOU 20 emails" and "we received YOUR LAST 20 mails", not
     "sent 20 emails". A single-space lookbehind matches neither and lets the complaint
     through as an order. JS allows a variable-length lookbehind; two words is enough for
     every phrasing seen and short enough not to reach across a clause. */
  String.raw`(?<!\b(?:${NOT_A_COUNT_BEFORE})\s+(?:\w+\s+){0,2})(?<![0-9,.])([0-9]{1,4})\s*(?:${SEAT_UNITS})\b` +
  String.raw`|\b(?:for|need|want|require|add|chahiye)\s+([0-9]{1,4})\s*(?:${SEAT_UNITS})\b`,
  "i",
);

function findSeats(text: string): Extracted<number> {
  const m = SEATS_RE.exec(text);
  if (!m) return { ...NONE };
  const n = Number(m[1] ?? m[2]);
  /* Zero is not a quantity anyone is asking for, and a five-figure seat count in an
     inbound email is far more likely to be a stray number than a real order. */
  if (!Number.isFinite(n) || n <= 0 || n > 9999) return { ...NONE };
  return { value: n, source: m[0].trim() };
}

/* ── Product ───────────────────────────────────────────────────────────────── */

/**
 * Matched against the tenant's OWN catalogue, longest name first.
 *
 * Longest-first because "Google Workspace Business Standard" contains "Google
 * Workspace" — matching the shorter one would quote the wrong plan at the wrong
 * price. Nothing is inferred from a vendor word alone: "we use Google" names a
 * company, not a SKU.
 */
function findProduct(text: string, catalogue: readonly CatalogueEntry[]): Extracted<CatalogueEntry> {
  const hay = text.toLowerCase();
  const byLength = [...catalogue].sort((a, b) => b.name.length - a.name.length);
  for (const item of byLength) {
    const needle = item.name.trim().toLowerCase();
    if (needle.length >= 4 && hay.includes(needle)) {
      return { value: item, source: item.name };
    }
  }
  return { ...NONE };
}

/* ── Name ──────────────────────────────────────────────────────────────────── */

/** Looks like a person's name, not an address or a company suffix. */
function plausibleName(s: string): boolean {
  const t = s.trim();
  if (t.length < 2 || t.length > 60) return false;
  if (t.includes("@") || /[0-9]/.test(t)) return false;
  if (/^(thanks|regards|best|sincerely|hi|hello|team|sales|support)$/i.test(t)) return false;
  return /^[\p{L}][\p{L}.'\- ]*$/u.test(t);
}

/**
 * The sender's name — from the mail header when it has one, otherwise from a
 * sign-off.
 *
 * The header is preferred because it is a fact the mail server recorded. A sign-off
 * is read only when there is no header name, and only the line immediately after a
 * closing word, which is where a name sits.
 */
function findName(fromName: string | null | undefined, body: string): Extracted<string> {
  const header = (fromName ?? "").trim();
  if (header && plausibleName(header)) {
    return { value: header, source: "sender name on the email" };
  }

  const m = /\n\s*(?:thanks|thank you|regards|best regards|warm regards|best|sincerely|cheers)[,!.]*\s*\n\s*([^\n]{2,60})/i
    .exec("\n" + body);
  if (m) {
    const candidate = m[1].trim().replace(/[,.]+$/, "");
    if (plausibleName(candidate)) {
      return { value: candidate, source: m[0].trim().replace(/\s+/g, " ") };
    }
  }
  return { ...NONE };
}

/* ── The whole thing ───────────────────────────────────────────────────────── */

export function extractEntities(input: {
  fromName:  string | null | undefined;
  fromEmail: string | null | undefined;
  subject:   string | null | undefined;
  body:      string | null | undefined;
  /** The tenant's catalogue. Empty is fine — product simply comes back null. */
  catalogue?: readonly CatalogueEntry[];
}): ExtractedEntities {
  const body    = input.body ?? "";
  const subject = input.subject ?? "";
  /* Subject first: "Quote for 20 seats of Microsoft 365" carries the whole enquiry
     often enough that it is worth searching before the body's small print. */
  const haystack = `${subject}\n${body}`;

  const headerEmail = (input.fromEmail ?? "").trim();
  const bodyEmail   = EMAIL_RE.exec(haystack)?.[0] ?? null;

  return {
    name:  findName(input.fromName, body),
    email: headerEmail
      ? { value: headerEmail, source: "sender address on the email" }
      : bodyEmail
        ? { value: bodyEmail, source: bodyEmail }
        : { ...NONE },
    phone:   findPhone(haystack),
    seats:   findSeats(haystack),
    product: findProduct(haystack, input.catalogue ?? []),
  };
}

/** How many fields were actually found — drives "3 of 5 details found". */
export function foundCount(e: ExtractedEntities): number {
  return [e.name, e.email, e.phone, e.seats, e.product].filter((f) => f.value != null).length;
}
