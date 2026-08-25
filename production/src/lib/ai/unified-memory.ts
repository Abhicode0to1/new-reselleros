/**
 * One memory across phone, email and WhatsApp — and the doubt travels with it.
 *
 * ─── HALF OF THIS ALREADY WORKED, AND HALF WAS MISSING ENTIRELY ─────────────
 * `loadSalesThread` takes a `channel` argument and never filters on it. That is deliberate and
 * it means email and WhatsApp turns have always shared one transcript: a customer who wrote by
 * mail in the morning and messaged on WhatsApp in the evening already gets one conversation.
 *
 * THE PHONE WAS NOT IN IT. A call transcript is written to `ai_telecall_logs` and nowhere else,
 * while the sales agent reads `ai_sales_conversations`. So the exact scenario in the brief — a
 * morning call about seats, an evening "Hi" on WhatsApp — met an agent that had never heard of
 * the call. Not a missing memory system; a missing channel in the one that exists.
 *
 * So the fix is one turn written into the shared transcript when a call ends, and everything
 * downstream works unchanged: `MAX_CONTEXT_TURNS` trims it, `loadSalesThread` picks it up, the
 * qualifier reads it.
 *
 * ─── WHAT THE BRIEF'S OWN EXAMPLE MESSAGE GETS WRONG ────────────────────────
 * "Subah humari phone par 20 seats Google Workspace ke baare mein baat hui thi. Kya aapne
 * quotation dekha?" — the recall is exactly right and two of its clauses are not.
 *
 * "20 SEATS" IS A NUMBER A MACHINE HEARD ON A PHONE LINE. `auto-send-quote.ts` already refuses
 * to price a seat count that came out of a transcribed voice note, and a live call is strictly
 * worse: crosstalk, accents, line quality, and "twenty" against "twelve" in one syllable. So
 * the number may be CONFIRMED and never RESTATED as settled — a figure read back as fact is a
 * figure the customer will assume we agreed, and then the quotation is for seats nobody asked
 * for. `recallFacts` produces "confirm the seat count" and never "you asked for 20".
 *
 * "KYA AAPNE QUOTATION DEKHA?" claims a document exists and reached them.
 * `SALES_AGENT_SYSTEM_PROMPT` already forbids saying a document was sent or attached — "You do
 * not control the envelope" — so that clause is refused before it can go out. It should be:
 * asking whether somebody read a quotation we never sent is a confusing first line, and if we
 * DID send one the recall block says so from the lead's own quote row instead of guessing.
 *
 * ─── AND THE RECALL MUST SURVIVE OUR OWN PROMISE GUARD ──────────────────────
 * "We spoke today" and "aaj baat hui thi" both contain tokens `findPromises` refuses — `today`
 * and `aaj` are unconditional date matches, and a reply held over a word describing the PAST
 * would make this feature unusable. Same trap the trade-in block fell into two features ago
 * with "runs on GoDaddy TODAY". So the wording here is "earlier" and "on our call", and a test
 * runs the guard over every line this module produces.
 *
 * ─── IDENTITY IS THE ACTUAL RISK, NOT MEMORY ────────────────────────────────
 * Merging two channels means deciding they are the same person. Get it wrong and we open one
 * customer's commercial position — their seat count, their product, the fact that they are
 * negotiating — to a stranger. That is a disclosure, not an inconvenience.
 *
 * Measured on the live table: 14 leads carry a phone number, 14 distinct, ZERO collisions
 * today. So this is a guard for later rather than a fix for now — and it is still required,
 * because at 28 leads zero is not evidence. A consultant handling IT for three small firms, a
 * shared office landline, the same person enquiring twice, a number that changed hands: each
 * produces one phone against several leads, and each is ordinary.
 *
 * So `resolveSharedIdentity` merges on the LEAD, and refuses to merge on a phone number that
 * matches more than one. Refusing costs a machine some context. Guessing costs a customer
 * their privacy.
 */
import { findPromises } from "./promise-check";

/* ── Where a heard number came from ───────────────────────────────────────── */

/**
 * The channel a machine-transcribed figure arrived on.
 *
 * Exists because the refusal in `auto-send-quote.ts` was worded for one of them — "the seat
 * count came from a transcribed voice note" — and a held quote whose reason names the wrong
 * channel sends the operator looking for a voice note that was never left.
 */
export type HeardSource = "voice_note" | "phone_call";

export function heardSourceLabel(source: HeardSource): string {
  return source === "phone_call"
    ? "a phone call, transcribed by the voice agent"
    : "a transcribed voice note";
}

/**
 * Why a quote built on a heard figure is held, naming the actual channel.
 *
 * §24: the reason states which fact is doubtful, where it came from, and what to do — the draft
 * is priced and one confirmation away, and the sentence says so.
 */
export function heardNotWrittenReason(source: HeardSource): string {
  return (
    `the seat count came from ${heardSourceLabel(source)}, not from anything the customer ` +
    "typed — the quote is drafted and priced; confirm the number with them and send it"
  );
}

/* ── The turn a call leaves in the shared transcript ───────────────────────── */

export interface CallTurnInput {
  /** The vendor's transcript. May be empty — a call can connect and produce nothing usable. */
  transcript: string | null;
  /** How the call ended, from `classifyCall`. */
  outcome: string;
  /** Seats the voice agent believes it heard. Recorded as HEARD, never as agreed. */
  seatsHeard: number | null;
  /** Product, if the call established one. Same treatment as the seat count. */
  productHeard: string | null;
  /** Roughly how long, in seconds. Null when the vendor did not say. */
  durationSeconds: number | null;
}

/** Longest transcript we put in the shared thread. A whole call would crowd out the rest. */
export const MAX_TRANSCRIPT_CHARS = 1_200;

/**
 * One `system` turn summarising a call, for `ai_sales_conversations`.
 *
 * ─── WHY `system` AND NOT `user` ─────────────────────────────────────────────
 * A transcript is not something the customer wrote. Filing it as a `user` turn would put
 * machine-heard words in the place where the qualifier looks for things the customer stated —
 * and `seats_source: "written"` turns on exactly that distinction. So it goes in as a NOTE,
 * which is how the prompt renders `system` turns, and reads as "here is what happened on a
 * call" rather than "here is what they said".
 */
export function callTurnFor(input: CallTurnInput): string {
  const parts: string[] = [`Phone call — ${input.outcome}.`];

  if (input.durationSeconds !== null && input.durationSeconds > 0) {
    const mins = Math.round(input.durationSeconds / 60);
    /* Minutes, not seconds, and never a figure the guard would read as a duration promise —
       "about 4 minutes" is a length, "in 4 minutes" is a commitment. Zero-minute calls say
       "under a minute" rather than "0 minutes", which reads as a bug. */
    parts.push(mins >= 1 ? `Lasted about ${mins} minute${mins === 1 ? "" : "s"}.` : "Lasted under a minute.");
  }

  if (input.productHeard) {
    parts.push(`Product discussed, as heard on the call: ${input.productHeard}.`);
  }

  if (input.seatsHeard !== null && input.seatsHeard > 0) {
    /* The wording is load-bearing. "HEARD, not confirmed in writing" is what stops a later turn
       treating it as established — and it is the same sentence the qualifier's seats_source rule
       needs in order to answer "inferred". */
    parts.push(
      `Seat count HEARD on the call: ${input.seatsHeard} — machine-transcribed, NOT confirmed ` +
        "in writing. Must be confirmed before it prices anything.",
    );
  }

  const transcript = input.transcript?.trim();
  if (transcript) {
    const clipped =
      transcript.length > MAX_TRANSCRIPT_CHARS
        ? `${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}… (transcript truncated)`
        : transcript;
    parts.push(`Transcript: ${clipped}`);
  }

  return parts.join(" ");
}

/* ── What the agent may say about an earlier call ──────────────────────────── */

export interface RecallInput {
  /** Was there a call on this lead before now? */
  hadCall: boolean;
  /** The product, ONLY if it is recorded on the lead — not merely heard. */
  writtenProduct: string | null;
  /** Seats, ONLY if recorded on the lead. */
  writtenSeats: number | null;
  /** Seats the call heard, when nothing is recorded. Drives a CONFIRM, never a restatement. */
  seatsHeardOnly: number | null;
  /** True when a quotation actually exists on this lead. */
  quoteExists: boolean;
}

/**
 * The recall block: what we may bring up from an earlier call, and how.
 *
 * Empty when there was no call, so an ordinary first message produces exactly the prompt it did
 * before this module existed.
 */
export function recallFacts(input: RecallInput): string[] {
  if (!input.hadCall) return [];

  const lines: string[] = [
    "YOU HAVE ALREADY SPOKEN TO THIS CUSTOMER ON THE PHONE",
    "Open by referring to that call — it is the single thing that makes this feel like one team",
    "rather than three separate systems. Say 'on our call earlier' and not a day or a time: you",
    "were not told when it happened, and a wrong 'this morning' undoes the whole effect.",
  ];

  if (input.writtenProduct) {
    lines.push("", `Product on record: ${input.writtenProduct}. You may refer to it directly.`);
  }

  if (input.writtenSeats !== null && input.writtenSeats > 0) {
    lines.push(
      `Seat count on record: ${input.writtenSeats}. This one is written down, so you may state it.`,
    );
  } else if (input.seatsHeardOnly !== null && input.seatsHeardOnly > 0) {
    /* THE RULE THE BRIEF'S EXAMPLE BREAKS. A number a machine heard on a phone line, read back
       as settled, is a number the customer will assume we agreed — and then the quotation is
       for seats nobody asked for. Asking is also the better sales move: it gives them a reason
       to reply. */
    lines.push(
      "",
      "A SEAT COUNT WAS HEARD ON THE CALL AND IS NOT IN WRITING.",
      "Do NOT state it back to them as settled, and do NOT put it in a total. Ask them to",
      "confirm how many people it is for. A number a machine heard on a phone line, read back",
      "as fact, is a number they will assume we agreed — and the quotation would then be for",
      "seats nobody asked for.",
    );
  }

  lines.push(
    "",
    input.quoteExists
      ? "A quotation exists on this lead. You may refer to it by its reference number if you"
      : "NO quotation exists on this lead yet. Do NOT ask whether they have seen one, and do not",
    input.quoteExists
      ? "were given one. Do not say it was sent or attached — you do not control the envelope."
      : "imply one is on its way. Ask for what you still need instead.",
  );

  return lines;
}

/* ── Identity ─────────────────────────────────────────────────────────────── */

export interface IdentityCandidate {
  leadId: string;
  /** Digits only, no country prefix — as `normaliseIndianPhone` produces. */
  phoneDigits: string | null;
  contactEmail: string | null;
}

export type IdentityVerdict =
  | { merge: true; leadId: string; on: "lead" | "phone" | "email" }
  | { merge: false; reason: string };

/**
 * Decide whether an incoming message on one channel belongs to a known lead.
 *
 * ─── AMBIGUITY IS A REFUSAL, NOT A TIE-BREAK ────────────────────────────────
 * When a phone number or an address matches MORE THAN ONE lead we do not choose. Choosing means
 * telling somebody about a deal that might be another company's — their seat count, their
 * product, the fact that they are negotiating. There is no tie-break that makes that safe, and
 * "most recent" is the most confident wrong answer available.
 *
 * A known `leadId` always wins: it came from the row we wrote, not from matching a string.
 */
export function resolveSharedIdentity(input: {
  knownLeadId: string | null;
  /** Digits of the number the message arrived from, when the channel gives one. */
  phoneDigits: string | null;
  contactEmail: string | null;
  candidates: readonly IdentityCandidate[];
}): IdentityVerdict {
  if (input.knownLeadId?.trim()) {
    return { merge: true, leadId: input.knownLeadId.trim(), on: "lead" };
  }

  const phone = input.phoneDigits?.trim();
  if (phone) {
    const hits = input.candidates.filter((c) => c.phoneDigits?.trim() === phone);
    if (hits.length === 1) return { merge: true, leadId: hits[0].leadId, on: "phone" };
    if (hits.length > 1) {
      return {
        merge: false,
        reason:
          `this number is on ${hits.length} different leads, so which conversation it belongs ` +
          "to is a guess — and guessing would tell one customer about another's deal. Handled " +
          "as a new enquiry; a person can link it.",
      };
    }
  }

  const email = input.contactEmail?.trim().toLowerCase();
  if (email) {
    const hits = input.candidates.filter((c) => c.contactEmail?.trim().toLowerCase() === email);
    if (hits.length === 1) return { merge: true, leadId: hits[0].leadId, on: "email" };
    if (hits.length > 1) {
      return {
        merge: false,
        reason:
          `this address is on ${hits.length} different leads, so which conversation it belongs ` +
          "to is a guess. Handled as a new enquiry; a person can link it.",
      };
    }
  }

  return {
    merge: false,
    reason: "nothing on this message matches a lead we already hold — treated as a new enquiry",
  };
}

/**
 * Self-check used by the tests: every line this module writes must survive the promise guard.
 *
 * Anything in a prompt can be echoed into a reply, and this module's whole subject is the PAST —
 * which is exactly where a date word appears naturally and gets refused. Exported so the
 * assertion lives next to the reason for it rather than only in the test file.
 */
export function recallLinesAreSendable(lines: readonly string[]): boolean {
  return findPromises(lines.join(" ")).safe;
}
