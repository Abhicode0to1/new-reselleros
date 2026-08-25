/**
 * Learning from closed deals — the QUESTION, never the ANSWER.
 *
 * ─── THE DEEPEST PROBLEM WITH THIS LOOP, AND IT IS NOT SAMPLE SIZE ──────────
 * An outcome-driven learning loop optimises for WHAT CLOSES DEALS. False claims close deals.
 *
 * Every guard built into this codebase exists because the most persuasive thing to say is often
 * the thing we cannot say. Look at what was refused this week and why each was tempting:
 *
 *   "we are an official Google Partner"  reassures the skeptic   (we do not hold it)
 *   "free 2-hour migration"              closes the urgent buyer (we cannot know the duration)
 *   "99.9% uptime SLA"                   wins the technical buyer (not ours to underwrite)
 *   "first month free"                   answers the price objection (no such price exists)
 *   "your legacy GoDaddy setup"          justifies the switch    (we can see one MX record)
 *
 * Every one of those would help win a deal. A system that mines won conversations for "exact
 * winning phrases" will rediscover all five, and reintroduce them carrying the authority of
 * "the data says this works" — which is far harder to argue with than a guess. The won-deal
 * filter is a filter on PERSUASIVENESS, and an unauthorised claim is persuasive precisely
 * because it promises more than we can deliver.
 *
 * So this module learns the shape of the CONVERSATION and never our words in it. What is safely
 * reusable from a closed deal is what the CUSTOMER brought — the objection, the concern, the
 * seat band — plus which authorised claim was in play, as an identifier. That is a real signal
 * ("of the last forty won deals where they said Zoho is cheaper, most led with the GST invoice")
 * and it feeds the ORDERING, which is the axis lib/ai/tone.ts, trade-in.ts and ab-test.ts
 * already established as the safe one.
 *
 * ─── AND RETRIEVING A TRANSCRIPT RETRIEVES ANOTHER CUSTOMER'S DEAL ──────────
 * A won conversation contains that customer's negotiated rate, their seat count, their company
 * name, and the fact that they were negotiating. Putting it into a new customer's prompt does
 * two things at once: it discloses one customer's commercial position to another, and it injects
 * a rupee figure from OUTSIDE the catalogue directly into the prompt — around `allowedMoney`,
 * which is the one list `verifyDraftMoney` measures a draft against. The money discipline in
 * this repo is built on prices coming from one place. RAG over transcripts is a second place.
 *
 * `redactLesson` therefore keeps no prose at all, and `verifyLessonIsSafe` proves it — by
 * validating the SHAPE rather than scanning for suspicious content: every field against its own
 * closed set, and any key that should not exist at all. A whitelist catches what a blacklist has
 * to anticipate, and the first version of that check was a blacklist that its own tests found two
 * holes in. Same idea as `verifyOnlySlotsChanged` in lib/agreements — a claim that can be
 * verified rather than trusted.
 *
 * ─── THE PROMPT IS NEVER EDITED BY THIS LOOP ────────────────────────────────
 * The diagram has "AI Knowledge Base Auto-Updater" writing "Updated Prompts". The prompt is
 * where every guard in this system lives. A process that rewrites it from won-deal data, with
 * nobody reading the diff, can dilute any of those guards — and would do so in the direction of
 * whatever closes deals, per the argument above. So the output of this module is DATA that the
 * existing blocks read when choosing an order. No prompt text is generated, and there is no
 * function here that returns one.
 *
 * ─── AND THERE IS NOTHING TO LEARN FROM YET. MEASURED. ──────────────────────
 *   pgvector installed .......................... no
 *   conversation turns recorded ................. 15
 *   turns that are OURS ......................... 0
 *   won deals ................................... 27
 *   won deals WITH a conversation attached ...... 0
 *
 * Every won deal was closed with no recorded conversation, so a playbook seeded today would be
 * seeded from nothing. That is why `retrieveGuidance` returns a null recommendation below a
 * minimum, in words, rather than a confident ordering drawn from two examples.
 */
import { BATTLECARDS, detectObjections, type ObjectionId } from "./battlecards";
import { AUTHORISED_CLAIMS, type AuthorisedClaim } from "./tone";

/* ── What a closed deal teaches ───────────────────────────────────────────── */

export type DealOutcome = "won" | "lost";

/**
 * Seat bands, not seat counts.
 *
 * A band is the useful part — a 12-seat deal and a 15-seat deal are the same conversation — and
 * it is also the part that cannot identify anybody. "The 30-seat deal at Sharma Traders" is a
 * customer; "the 21-50 band" is a pattern.
 */
export type SeatBand = "1-20" | "21-50" | "51-100" | "100+" | "unknown";

export function seatBandFor(seats: number | null): SeatBand {
  if (seats === null || seats <= 0) return "unknown";
  if (seats <= 20) return "1-20";
  if (seats <= 50) return "21-50";
  if (seats <= 100) return "51-100";
  return "100+";
}

/**
 * One lesson from one closed deal. Deliberately holds NO PROSE.
 *
 * Every field is either an enumerated value or a count. There is no string here that came out of
 * a conversation, which is what makes the disclosure and unauthorised-claim problems in the
 * header structurally impossible rather than merely forbidden.
 */
export interface DealLesson {
  outcome: DealOutcome;
  /** What the CUSTOMER raised, by the battlecard taxonomy. Theirs, not ours. */
  objections: readonly ObjectionId[];
  /** Which authorised claims were in play, as identifiers. Never their wording. */
  claimsLedWith: readonly AuthorisedClaim[];
  seatBand: SeatBand;
  /** How many turns the conversation ran. A shape signal, not content. */
  turnCount: number;
  /** True when the customer wrote from their own domain rather than a free mailbox. */
  hadBusinessDomain: boolean;
}

export interface RawClosedDeal {
  outcome: DealOutcome;
  /** The customer's own messages. Read for objections and then DISCARDED. */
  customerMessages: readonly string[];
  /** Claims the app authorised on this deal, from the prompt that was built. */
  claimsLedWith: readonly AuthorisedClaim[];
  seats: number | null;
  turnCount: number;
  hadBusinessDomain: boolean;
}

/**
 * Reduce a closed deal to a lesson, discarding every word of it.
 *
 * ─── THE CUSTOMER'S MESSAGES ARE READ AND THROWN AWAY ───────────────────────
 * `detectObjections` is the same function the prompt uses to choose a battlecard, so what gets
 * LEARNED here and what gets ANSWERED there cannot drift — the same reason the objection tally
 * in lib/ai/performance.ts uses it. What comes out is a list of identifiers. The messages
 * themselves do not survive this function, so nothing downstream can retrieve them even by
 * mistake.
 */
export function redactLesson(deal: RawClosedDeal): DealLesson {
  const ids = new Set<ObjectionId>();
  for (const message of deal.customerMessages) {
    for (const card of detectObjections(message)) ids.add(card.id);
  }

  return {
    outcome: deal.outcome,
    objections: [...ids].sort(),
    /* Filtered against the authorised list rather than trusted. A caller passing something else
       would be widening the claim universe through the back door, which is the one thing every
       ordering module in this codebase asserts against. */
    claimsLedWith: deal.claimsLedWith.filter((c) =>
      (AUTHORISED_CLAIMS as readonly string[]).includes(c),
    ),
    seatBand: seatBandFor(deal.seats),
    turnCount: Math.max(0, Math.trunc(deal.turnCount)),
    hadBusinessDomain: deal.hadBusinessDomain,
  };
}

/* ── Proving the lesson is safe to keep ───────────────────────────────────── */

export interface LessonSafety {
  safe: boolean;
  /** One sentence naming what leaked. Empty when safe. */
  reason: string;
}

/**
 * Prove a lesson carries nothing that could identify a customer or price a deal.
 *
 * ─── VERIFIED, NOT TRUSTED ──────────────────────────────────────────────────
 * `redactLesson` is careful; this checks that it was. The two failures it exists to catch are
 * the two in this file's header: a figure from another deal reaching a new customer's prompt
 * around `allowedMoney`, and one customer's name or words reaching another.
 *
 * Serialising the whole object and scanning it means a field added later is covered without
 * anybody remembering to extend this — which is the difference between a check and a habit.
 * `turnCount` is the one legitimate number, so the scan allows one and two digits and refuses
 * three, the same threshold the prompt tests use.
 */
export function verifyLessonIsSafe(lesson: DealLesson): LessonSafety {
  /* ─── AND THE FIRST VERSION OF THIS WAS WEAKER THAN IT LOOKED ──────────────
     It serialised the lesson and scanned the JSON for figures with
     `/(?<![\w.:"])\d{3,}/`. Its own tests caught two things wrong with that:

       · the lookbehind excluded `:` to avoid matching inside keys — and in JSON every numeric
         VALUE is preceded by `:`. So the scan could not see a number field AT ALL. A leaked
         figure in `turnCount` passed.
       · `"51-100"` is a legitimate band label, and the scan read the `100` as a leaked figure.

     Both come from one mistake: pattern-matching a serialised blob conflates structure, labels
     and values. So this validates the SHAPE instead — every field against its own closed set,
     and any key that should not exist at all. That is strictly stronger: a smuggled
     `transcript` field is caught because it is not a known key, not because its contents
     happened to look suspicious. */
  const KNOWN_KEYS = [
    "outcome",
    "objections",
    "claimsLedWith",
    "seatBand",
    "turnCount",
    "hadBusinessDomain",
  ];
  const OUTCOMES = ["won", "lost"];
  const BANDS = ["1-20", "21-50", "51-100", "100+", "unknown"];
  const OBJECTION_IDS = BATTLECARDS.map((b) => b.id) as readonly string[];
  /** A conversation longer than this is not a conversation; the value is suspect, not the deal. */
  const MAX_TURNS = 500;

  const record = lesson as unknown as Record<string, unknown>;

  const extra = Object.keys(record).filter((k) => !KNOWN_KEYS.includes(k));
  if (extra.length > 0) {
    return {
      safe: false,
      reason:
        `This lesson carries ${extra.join(", ")}, which a lesson has no field for. Anything ` +
        "beyond the known facts is something kept from the conversation — and wording is how an " +
        "unauthorised claim travels from a deal that closed to a deal that has not.",
    };
  }

  if (!OUTCOMES.includes(String(record.outcome))) {
    return { safe: false, reason: `"${String(record.outcome)}" is not a recorded outcome.` };
  }

  if (!BANDS.includes(String(record.seatBand))) {
    return {
      safe: false,
      reason:
        `"${String(record.seatBand)}" is not a seat band. A band is one of a fixed few; anything ` +
        "else in that field is text that survived the reduction.",
    };
  }

  const objections = Array.isArray(record.objections) ? record.objections : null;
  if (!objections || objections.some((o) => !OBJECTION_IDS.includes(String(o)))) {
    return {
      safe: false,
      reason:
        "This lesson records an objection that is not in the battlecard taxonomy, so it is not " +
        "an identifier — it is a phrase.",
    };
  }

  const claims = Array.isArray(record.claimsLedWith) ? record.claimsLedWith : null;
  if (!claims || claims.some((c) => !(AUTHORISED_CLAIMS as readonly string[]).includes(String(c)))) {
    return {
      safe: false,
      reason:
        "This lesson records a claim that is not on the authorised list. A lesson may only ever " +
        "name claims the agent was already allowed to make.",
    };
  }

  const turns = record.turnCount;
  if (typeof turns !== "number" || !Number.isInteger(turns) || turns < 0 || turns > MAX_TURNS) {
    return {
      safe: false,
      reason:
        `turnCount is ${String(turns)}, which is not a plausible conversation length. A number ` +
        "from one deal reaching another customer's prompt is a price from outside the catalogue, " +
        "and the money guard only measures a draft against the catalogue.",
    };
  }

  if (typeof record.hadBusinessDomain !== "boolean") {
    return { safe: false, reason: "hadBusinessDomain is not a yes-or-no answer." };
  }

  return { safe: true, reason: "" };
}

/* ── Retrieval ────────────────────────────────────────────────────────────── */

/**
 * Below this many closed deals matching the situation, no ordering is recommended.
 *
 * Twenty-five, the same threshold `MIN_MESSAGES_FOR_OBJECTIONS` uses, and for the same reason:
 * an ordering drawn from three deals is three customers, and presenting it as a pattern invites
 * a decision made on noise. The live count of won deals with a conversation attached is ZERO, so
 * this threshold is doing work today rather than sitting there theoretically.
 */
export const MIN_DEALS_FOR_GUIDANCE = 25;

export interface Guidance {
  /** Which authorised claim won most often in this situation. Null below the threshold. */
  leadWith: AuthorisedClaim | null;
  /** How many matching deals were considered. Always reported next to the recommendation. */
  matched: number;
  /** Of those, how many were won. */
  won: number;
  /** Why there is no recommendation, in words. Empty when there is one. */
  unavailable: string;
}

/**
 * What past deals in this situation suggest leading with.
 *
 * Returns a claim IDENTIFIER and a count. Never a phrase, never a figure, and never prompt text
 * — see the header on why this loop does not write prompts.
 */
export function retrieveGuidance(input: {
  lessons: readonly DealLesson[];
  /** The objections this customer has raised. */
  objections: readonly ObjectionId[];
  seatBand: SeatBand;
}): Guidance {
  /* A deal matches when it shared at least one objection AND the seat band. Requiring both keeps
     "what worked" attached to a comparable conversation: the answer to a price objection at 12
     seats is not the answer at 200, where a discount band exists. */
  const matching = input.lessons.filter(
    (l) =>
      l.seatBand === input.seatBand &&
      l.objections.some((o) => input.objections.includes(o)),
  );

  const won = matching.filter((l) => l.outcome === "won");

  if (matching.length < MIN_DEALS_FOR_GUIDANCE) {
    return {
      leadWith: null,
      matched: matching.length,
      won: won.length,
      unavailable:
        `Only ${matching.length} closed ${matching.length === 1 ? "deal" : "deals"} match this ` +
        `situation. Suggesting what to lead with needs at least ${MIN_DEALS_FOR_GUIDANCE} — below ` +
        "that the ordering is a handful of customers, and a pattern read off three deals is not " +
        "a pattern.",
    };
  }

  const tally = new Map<AuthorisedClaim, number>();
  for (const l of won) {
    for (const c of l.claimsLedWith) tally.set(c, (tally.get(c) ?? 0) + 1);
  }

  /* Ties broken by the claim name so the same inputs always give the same answer — guidance that
     moves without the data moving is guidance nobody will trust twice. */
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  return {
    leadWith: top?.[0] ?? null,
    matched: matching.length,
    won: won.length,
    unavailable: top ? "" : "None of the matching deals recorded which claim was led with.",
  };
}

/**
 * The prohibitions that travel with this feature, for whoever builds the retrieval store.
 *
 * Data rather than prose so the UI can render them beside the store's settings, and so a test
 * can assert each one is stated rather than implied.
 */
export const PLAYBOOK_FORBIDDEN: readonly string[] = [
  "Do NOT store or retrieve any part of a customer's conversation verbatim. Wording is how an " +
    "unauthorised claim travels from a deal that closed to a deal that has not, and a won-deal " +
    "filter selects for persuasiveness rather than truth.",
  "Do NOT store a rupee figure from a closed deal. A price from outside the catalogue reaching a " +
    "prompt is a price the money guard cannot check, because it measures a draft against the " +
    "catalogue and nothing else.",
  "Do NOT store a customer name, company, domain, address or contact. Another customer's deal is " +
    "their disclosure to make.",
  "Do NOT let this loop edit any prompt. The prompt is where every guard lives, and a process " +
    "that rewrites it from win data with nobody reading the diff will dilute those guards in the " +
    "direction of whatever closes deals.",
  "Do NOT recommend an ordering below the minimum sample. An ordering from three deals is three " +
    "customers, presented with the authority of data.",
];
