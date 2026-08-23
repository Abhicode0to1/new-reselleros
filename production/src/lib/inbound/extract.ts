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

/** Monthly or annual, only when the sender actually said which. */
export type BillingTerm = "monthly" | "annual";

export interface ExtractedEntities {
  name:    Extracted<string>;
  email:   Extracted<string>;
  phone:   Extracted<string>;
  seats:   Extracted<number>;
  product: Extracted<CatalogueEntry>;
  /**
   * Null is the normal answer, and it is the useful one.
   *
   * Added 23 Aug 2026 for a specific reason: a quote built from an email has to pick a
   * term, and "50 Business Starter" does not name one. The auto-draft assumes annual and
   * writes that assumption on the document, which is fine for a draft a human opens. It
   * would NOT be fine for a quote the app sends by itself — an assumed term reaching a
   * customer is a price they can hold us to.
   *
   * So this field is the switch: term stated → the quote is safe to send unattended;
   * term absent → the draft waits for a person. That makes "did they say?" a value in the
   * data rather than a judgement made twice in two places.
   */
  term:    Extracted<BillingTerm>;
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

/**
 * SECOND PASS ONLY — the product name sitting between the number and the seat word.
 *
 * "I need a quotation for 50 Google Workspace Business Starter users" was measured on
 * 23 Aug 2026 to yield NO seat count, because `SEATS_RE` wants the unit immediately after
 * the number and here four words stand in between. That is not an exotic phrasing; it is
 * the most natural way to ask, and it is the one Pardeep used when he asked whether the
 * flow works.
 *
 * ─── WHY THIS IS A SEPARATE PASS AND NOT A WIDER `SEATS_RE` ─────────────────
 * `exec` returns the FIRST match in the string. Widening the gap in the one regex would
 * let an EARLIER, wrong number win a race it currently loses:
 *
 *     "12 months for 30 users"   → widened: 12 (months is not a unit, "for 30" is the gap)
 *                                  today:   30, which is the right answer
 *
 * Running strict first and this only when strict found nothing means the change can turn
 * a null into a number and can NEVER change a number the strict pass already returns.
 * Every existing case is untouched by construction, not by luck.
 *
 * ─── THE NUMBER MUST BE INTRODUCED AS A QUANTITY ────────────────────────────
 * The first draft of this just widened the gap and let any number in. Two of its own tests
 * broke it, and both failures were worth more than the feature:
 *
 *   "Please quote 20 Microsoft 365 Business Premium licenses."  → 365
 *       `exec` walked past 20 (the gap after it holds "365", which was not letters) and
 *       matched the 365 INSIDE the product name, gap "Business Premium". A product name
 *       with a number in it is not an edge case in this market — Microsoft 365 is half of
 *       what gets quoted.
 *
 *   "Kindly send rates for 8 Zoho Mail Lite mailboxes."         → null
 *       killed by the message-count lookbehind: "send" + "rates for" (two words) + the
 *       number. `SEATS_RE` survives that phrasing only because it carries a second
 *       alternative keyed on for/need/want, which this pass had not copied.
 *
 * Both point the same way: do not ask what stands AFTER the number, ask what stands
 * BEFORE it. A seat count is introduced — "for 50", "need 50", "quote 50", or a sentence
 * beginning with it. A number buried mid-phrase is part of a name, a price or a date.
 *
 * That single requirement disposes of the money cases structurally rather than by
 * vocabulary: "our price is 270 per user", "offer 15 percent discount for users", "GST is
 * 18 percent on all accounts" — none of those numbers is introduced as a quantity, so none
 * is ever considered. GAP_NOT_ALLOWED stays as a second line for phrasings that do get
 * introduced and still are not counts ("for 270 rupees per mailbox").
 *
 * The gap tokens may now contain digits, because "Microsoft 365" has to be crossable. That
 * is safe here in a way it would not be in one widened regex: strict-first already owns
 * every case where an adjacent unit exists, so "for 12 months for 30 users" is decided by
 * the strict pass before this one is ever consulted.
 */
const QUANTITY_INTRO =
  "for|need|needs|needed|want|wants|require|requires|add|adding|chahiye|quote|quoting|send";

const SEATS_GAPPED_RE = new RegExp(
  /* Introduced by a quantity word … */
  String.raw`(?:\b(?:${QUANTITY_INTRO})\s+` +
  /* … or standing at the very start of a sentence. */
  String.raw`|(?:^|[.\n;:!?]\s*))` +
  String.raw`([0-9]{1,4})\s+((?:[A-Za-z0-9]+\s+){1,4})(?:${SEAT_UNITS})\b`,
  "i",
);

/** Words that mean the number before them is a rate, a period or a percentage. */
const GAP_NOT_ALLOWED = new Set([
  "per", "each", "price", "prices", "priced", "cost", "costs", "rate", "rates",
  "month", "months", "monthly", "year", "years", "yearly", "annum", "annual",
  "day", "days", "week", "weeks",
  "rs", "inr", "rupee", "rupees", "percent", "pct", "discount", "off", "gst", "tax",
]);

function findSeatsGapped(text: string): Extracted<number> {
  const m = SEATS_GAPPED_RE.exec(text);
  if (!m) return { ...NONE };
  const gapWords = (m[2] ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (gapWords.some((w) => GAP_NOT_ALLOWED.has(w))) return { ...NONE };
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 9999) return { ...NONE };
  /* The whole span is the source, product name included — a rep checking "50" needs to
     see it was read from "50 Google Workspace Business Starter users" and not from a
     price line four sentences away. */
  return { value: n, source: m[0].trim() };
}

/**
 * Is this match's number sitting INSIDE one of the tenant's own product names?
 *
 * ─── A PRE-EXISTING BUG, FOUND 23 AUG 2026 BY A TEST WRITTEN FOR SOMETHING ELSE ──
 * "We already use Microsoft 365 accounts here." returned **365 seats**, and had done for as
 * long as `SEATS_RE` has existed — nothing to do with the gapped pass added alongside this.
 * Verified by stashing the new file and re-running: same 365. "accounts", "licenses" and
 * "mailboxes" are all seat units, so any product name ending in a number sits one space
 * away from one.
 *
 * It matters more than a missing count does. A missing count leaves a blank somebody fills
 * in; this one hands a rep a 365-seat quote off a sentence that was not an order at all,
 * and 365 × a Workspace tier is a five-figure document.
 *
 * The catalogue is the right authority for it — the same list `findProduct` matches
 * against, longest name first, so "Microsoft 365 Business Premium" is recognised as one
 * name rather than a vendor plus a number. A number falling inside that span is part of the
 * name; a number outside it is still a candidate. With an empty catalogue nothing is known
 * and nothing is rejected, which keeps this from being a silent behaviour change for any
 * caller that passes none.
 */
function insideProductName(
  text: string,
  numberIndex: number,
  catalogue: readonly CatalogueEntry[],
): boolean {
  const lower = text.toLowerCase();
  for (const item of catalogue) {
    const needle = item.name.replace(/\s+/g, " ").trim().toLowerCase();
    if (needle.length < 4) continue;
    /* Every occurrence, not just the first: the same product can be named twice in one
       mail, and only one of them need overlap the number. */
    for (let from = 0; ; ) {
      const at = lower.indexOf(needle, from);
      if (at === -1) break;
      if (numberIndex > at && numberIndex < at + needle.length) return true;
      from = at + 1;
    }
  }
  return false;
}

function findSeats(text: string, catalogue: readonly CatalogueEntry[] = []): Extracted<number> {
  const m = SEATS_RE.exec(text);
  /* Strict first, always. The gapped pass runs ONLY when this one found nothing, so it can
     add an answer and never change one — see SEATS_GAPPED_RE for why that ordering is the
     whole safety argument. */
  if (!m) return findSeatsGapped(text);
  const n = Number(m[1] ?? m[2]);
  /* Zero is not a quantity anyone is asking for, and a five-figure seat count in an
     inbound email is far more likely to be a stray number than a real order. */
  if (!Number.isFinite(n) || n <= 0 || n > 9999) return { ...NONE };
  /* The digits' own offset, not the match's: the match may open with "for " or a sentence
     break, and it is the NUMBER that has to be shown outside the product name. */
  const digitsAt = m.index + m[0].indexOf(String(n));
  if (insideProductName(text, digitsAt, catalogue)) {
    /* Part of a name here, but a real count may still follow it — "we use Microsoft 365
       accounts and need 20 more mailboxes". Hand over rather than give up. */
    return findSeatsGapped(text);
  }
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
  /* Whitespace collapsed on BOTH sides before matching. Mail clients hard-wrap, so a
     real reply arrives as "20 users of Google Workspace Business\nStandard" and an
     exact substring test misses its own catalogue name — found 23 Aug 2026 while
     building the Phase 1 write-back, on the very message that prompted it.
     This is not a loosening of the rule above: the full name is still required, it is
     just no longer defeated by a line break. */
  const flatten = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const hay = flatten(text);
  const byLength = [...catalogue].sort((a, b) => b.name.length - a.name.length);
  for (const item of byLength) {
    const needle = flatten(item.name);
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
    seats:   findSeats(haystack, input.catalogue ?? []),
    product: findProduct(haystack, input.catalogue ?? []),
    term:    findTerm(haystack),
  };
}

/* ── Billing term ──────────────────────────────────────────────────────────── */

/**
 * Says monthly or annual ONLY when the sender did. Anything ambiguous stays null.
 *
 * Fails toward null on purpose, and hard. A wrong term is not a cosmetic error: annual
 * bills twelve months at once, so reading "monthly" as "annual" multiplies a customer's
 * invoice by twelve, and the other direction quotes a twelfth of the deal. Given that,
 * "we could not tell" is a far better answer than a confident guess — the draft simply
 * waits for a person, which is what it did before this field existed.
 *
 * BOTH TERMS IN ONE MAIL YIELDS NULL. "What's the price monthly, and yearly?" is a
 * question about both, not a choice of one, and picking whichever matched first would turn
 * a comparison request into an order. This is the case a keyword search gets wrong.
 */
const ANNUAL_RE  = /\b(?:annual(?:ly)?|yearly|per\s*(?:year|annum)|a\s*year|for\s*(?:1|one)\s*year|12\s*months?|saalana)\b/i;
const MONTHLY_RE = /\b(?:month(?:ly)?|per\s*month|a\s*month|p\.?m\.?|mahina|maheena)\b/i;

function findTerm(text: string): Extracted<BillingTerm> {
  const annual  = ANNUAL_RE.exec(text);
  const monthly = MONTHLY_RE.exec(text);

  /* "12 months" matches BOTH patterns by design — it is an annual commitment expressed in
     months. Resolved before the both-matched check, or every annual mail written that way
     would come back null. */
  if (annual && monthly && annual.index === monthly.index) {
    return { value: "annual", source: annual[0].trim() };
  }
  if (annual && monthly) return { ...NONE };
  if (annual)  return { value: "annual",  source: annual[0].trim() };
  if (monthly) return { value: "monthly", source: monthly[0].trim() };
  return { ...NONE };
}

/** How many fields were actually found — drives "3 of 5 details found". */
export function foundCount(e: ExtractedEntities): number {
  return [e.name, e.email, e.phone, e.seats, e.product].filter((f) => f.value != null).length;
}
