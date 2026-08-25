/**
 * Reading the register a customer wrote in, and answering in it.
 *
 * The signal for this was already being produced and thrown away: `perceived_sentiment` comes
 * back on every single decision, is written to the audit log at quote-dispatcher.ts:134, 184 and
 * 254 — and is read by nothing. The model has been telling us how the customer sounds since the
 * day the agent shipped, and no reply has ever changed because of it.
 *
 * ─── THE ONE LINE THAT MAKES THIS SAFE ──────────────────────────────────────
 * TONE CHANGES WHICH AUTHORISED FACT WE LEAD WITH, AND HOW WE WRITE IT. IT NEVER ADDS A FACT.
 *
 * That is not a stylistic preference, it is the whole design. A tone module that could attach
 * new claims would be the most dangerous file in this repo, because it would attach them
 * exactly where they are most likely to be believed and least likely to be checked: a
 * reassuring credential to the customer who said they are unsure, a speed promise to the
 * customer who said they are in a hurry.
 *
 * So this module names claims by LABEL and never restates them. The four authorised sentences
 * live in one place — `SALES_AGENT_SYSTEM_PROMPT`'s "WHAT YOU MAY PROMISE" list — and are not
 * copied here, because a second copy of a claim rule stops matching the first. A tone can say
 * "lead with the GST invoice"; it cannot say what the GST invoice sentence is.
 *
 * ─── WHAT THE BRIEF ASKED FOR, AND WHAT IS REFUSED ──────────────────────────
 * The brief paired each tone with specific material. Three of those cannot be said, and each
 * refusal below was measured rather than reasoned:
 *
 *   · "official Google Partner Certificate" to the hesitant customer.
 *     TASKS.md:1564 — the Google reseller agreement is NOT approved and is recorded there as
 *     "not obtainable by a developer". We do not hold the certificate. And this is aimed at the
 *     one customer who will check: Google's partner directory is public, and a skeptic who
 *     looks us up and does not find us has been given a reason to distrust everything else in
 *     the mail. A false credential is worse than no credential, and worst of all to a skeptic.
 *
 *   · "client logos" to the hesitant customer.
 *     There is no consent field anywhere in this schema — grep found none. Naming another
 *     customer to a prospect is that customer's disclosure to make, not ours, and the first
 *     tenant on this platform is the company itself.
 *
 *   · "instant 10-minute setup" to the urgent customer.
 *     `provisioning.activate` is `off` on the autonomy dial and `decideProvisioning` refuses on
 *     test keys, so a ten-minute activation cannot happen today even if the claim were true. It
 *     also depends on Google's API, on payment clearing and on domain verification, none of
 *     which we control. And it walked straight through `findPromises` until this commit.
 *
 *   · a "24/7 phone support SLA" figure, which the brief attached to the hesitant customer.
 *     `SALES_AGENT_SYSTEM_PROMPT` already forbids contractual terms, and the response-time
 *     number slipped the guard for a specific reason worth recording: the draft is passed
 *     through `maskAuthorisedSellingPoints` BEFORE `findPromises` reads it, which turns "24/7"
 *     into "round-the-clock" — so "our 24/7 phone support SLA is a 15 minute response" lost the
 *     only token the guard was catching and came back safe. Round-the-clock support is an
 *     authorised claim; a number attached to it is a contract.
 *
 * What IS kept from the brief is the part that was right: a price-sensitive customer should
 * hear about the GST invoice and the real net cost before anything else, a hesitant one should
 * hear who they would be dealing with, and an urgent one should get a short mail with the next
 * step in the first line. All three of those are reordering, not inventing.
 */

/* ── The claims, by label only ─────────────────────────────────────────────── */

/**
 * The four things the agent may say, as identifiers.
 *
 * Deliberately NOT the sentences. The wording lives in `SALES_AGENT_SYSTEM_PROMPT`'s
 * "WHAT YOU MAY PROMISE" list and stays there; this file only ever chooses an order among
 * these labels. A test asserts every tone's selection is a subset of this array, which is what
 * makes "tone never adds a fact" a property of the code rather than a promise in a comment.
 */
export const AUTHORISED_CLAIMS = [
  "gst_invoice",
  "inr_billing",
  "migration_included",
  "local_support",
] as const;

export type AuthorisedClaim = (typeof AUTHORISED_CLAIMS)[number];

/** How to refer to a claim in an instruction. Not the claim itself — a pointer to it. */
const CLAIM_LABEL: Record<AuthorisedClaim, string> = {
  gst_invoice: "the GST tax invoice and the input tax credit it carries",
  inr_billing: "being billed in rupees by an Indian company",
  migration_included: "migration of their existing mail being included",
  local_support: "round-the-clock support from a local team",
};

/* ── Tones ─────────────────────────────────────────────────────────────────── */

export type Tone = "price_sensitive" | "hesitant" | "urgent" | "neutral";

export interface ToneProfile {
  readonly id: Tone;
  /**
   * Whole-word cues, English and Hinglish. Matched with word boundaries for the same reason
   * `battlecards.ts` does it: substring matching turns "costume" into a price objection.
   */
  readonly cues: readonly string[];
  /** Which authorised claims to lead with, in order. A SUBSET of AUTHORISED_CLAIMS. */
  readonly leadWith: readonly AuthorisedClaim[];
  /** How to write. Length, directness, what to put in the first line. */
  readonly register: readonly string[];
  /**
   * What must NOT be said to this customer, with the reason.
   *
   * The reason travels into the prompt with the prohibition, because a bare "do not mention
   * partner status" invites a workaround and "we are not a listed Google partner yet" does
   * not. It is also what a colleague reads when they wonder why the mail was plainer than
   * they expected.
   */
  readonly refuse: readonly string[];
}

export const TONE_PROFILES: readonly ToneProfile[] = [
  {
    id: "price_sensitive",
    cues: [
      "mehenga", "mehnga", "menga", "costly", "expensive", "budget", "sasta", "cheap",
      "cheaper", "kam karo", "discount", "zyada hai", "bahut hai", "bohot hai",
      "afford", "price too high", "high price", "rate kam",
    ],
    /* Cost first, and specifically the part of the cost that comes BACK. The net-cost block in
       the prompt already computes it from our own invoice. */
    leadWith: ["gst_invoice", "inr_billing"],
    register: [
      "Answer the number, do not talk around it. A customer who said it is expensive and gets",
      "a paragraph about features reads that as a dodge.",
      "Give the per-seat price with its unit, then what comes back to them, then stop.",
    ],
    refuse: [
      "Do NOT offer monthly billing as the cheaper option. It is a real tier here, but the",
      "flex-monthly rate is per seat per MONTH and normally works out DEARER per month than a",
      "twelfth of the annual rate — see lib/quotes/commitment-rate.ts. Offering it as relief to",
      "somebody who just said the price is high is selling them the more expensive option while",
      "it sounds like a concession.",
      "Do NOT state a card, forex or bank percentage. You do not know their bank, and issuers",
      "charge a range rather than one number.",
      "Do NOT offer a discount to close the objection. The volume rate card is the only",
      "discount that exists and the application applies it by seat count, not by argument.",
    ],
  },
  {
    id: "hesitant",
    cues: [
      "pehle kabhi", "never bought", "not sure", "bharosa", "trust", "genuine", "fraud",
      "scam", "kaise pata", "how do i know", "reference", "reviews", "kaun ho", "new company",
      "naya", "risk", "safe hai", "verify",
    ],
    /* What is checkable, not what is impressive. A GST invoice carries our GSTIN, which they
       can look up on the government portal in under a minute — which is worth more to a
       skeptic than any claim we could make about ourselves. */
    leadWith: ["gst_invoice", "local_support"],
    register: [
      "Be concrete and checkable. Name the company, and let the GST invoice do the reassuring —",
      "its GSTIN is verifiable on the government portal in under a minute, which is worth more",
      "to somebody who is unsure than anything you could say about yourselves.",
      "Offer a call with a person. That is the strongest thing on this list and it costs",
      "nothing to say, because it is entirely within our control.",
    ],
    refuse: [
      "Do NOT claim to be an official, certified or authorised Google, Microsoft or Zoho",
      "partner, and do NOT mention a partner certificate, badge, tier or ID. The reseller",
      "agreement is not approved (TASKS.md:1564). This is the one customer who will check, the",
      "partner directories are public, and a skeptic who looks us up and does not find us has",
      "been given a reason to disbelieve the rest of the mail.",
      "Do NOT name another customer, quote one, or refer to client logos or a client list. We",
      "hold no consent to do it and it is their disclosure to make, not ours.",
      "Do NOT attach a number to support — no response time, no resolution time, no uptime, no",
      "SLA. Round-the-clock support is authorised; a figure next to it is a contract.",
      "Do NOT offer a trial, a refund or a money-back arrangement. None of those exist here.",
    ],
  },
  {
    id: "urgent",
    cues: [
      "aaj hi", "abhi", "urgent", "jaldi", "asap", "turant", "immediately", "right away",
      "today itself", "kal tak", "emergency", "chalu chahiye", "chahiye aaj", "start now",
      "quickly", "fast",
    ],
    /* Nothing about speed, because we cannot commit to any. Migration being included is the
       one thing on the list that answers "what happens next" without timing it. */
    leadWith: ["migration_included", "local_support"],
    register: [
      "Short. The next step goes in the FIRST line, not the last, and the mail is three or four",
      "sentences. Somebody in a hurry who gets four paragraphs reads none of them.",
      "Say exactly what you need from them to move, and say who will do the next part.",
      "Urgency is answered by being easy to act on, not by promising to be quick.",
    ],
    refuse: [
      "Do NOT state how long anything will take. Not ten minutes, not an hour, not today, not",
      "'instant' or 'immediate'. Provisioning depends on Google's API, on the payment clearing",
      "and on their domain being verified — none of which we control — and automatic activation",
      "is switched off on this platform, so the fastest honest answer is what happens next and",
      "who does it.",
      "Do NOT promise a same-day or next-day anything, in English or in Hindi.",
      "Their hurry is a reason to reply in fewer words, never a reason to commit to a clock.",
    ],
  },
  {
    id: "neutral",
    cues: [],
    /* Empty, and that is the point: with no signal, nothing is reordered and the prompt is
       exactly what it was before this module existed. */
    leadWith: [],
    register: [],
    refuse: [],
  },
] as const;

export function toneProfile(id: Tone): ToneProfile {
  const found = TONE_PROFILES.find((t) => t.id === id);
  if (!found) throw new Error(`unknown tone: ${id}`);
  return found;
}

/* ── Detection ─────────────────────────────────────────────────────────────── */

/** Cue matching, whole-word, accent- and case-insensitive. */
function cueHits(message: string, cues: readonly string[]): string[] {
  const hay = ` ${message.toLowerCase().replace(/[^\p{L}\p{N}\s%]/gu, " ").replace(/\s+/g, " ")} `;
  return cues.filter((c) => hay.includes(` ${c.toLowerCase()} `));
}

export interface ToneReading {
  tone: Tone;
  /** The words that decided it, for the audit log and for a colleague reading the timeline. */
  cues: readonly string[];
  /** Every tone that had a cue, strongest first. More than one is common and normal. */
  alsoSaw: readonly Tone[];
}

/**
 * Read the register from the customer's own words.
 *
 * ─── WHY THE MESSAGE AND NOT `perceived_sentiment` ──────────────────────────
 * The model's sentiment field is a free-text string it writes itself, so switching behaviour on
 * it would mean the model choosing its own instructions — and this is the module whose whole
 * safety argument is that it constrains rather than expands. Cues in the customer's text are
 * something we can point at afterwards: "it said 'bohot mehenga'" is checkable, "the model felt
 * they were price sensitive" is not. The sentiment field is still logged; it is just not in
 * charge.
 *
 * ─── WHEN TWO TONES BOTH FIRE ───────────────────────────────────────────────
 * Common: "bohot mehenga hai, aur aaj hi chahiye" is both. The strongest cue count wins, and
 * on a tie the order below decides — URGENT first, because its instruction set is the most
 * restrictive (it forbids every timing claim) and a tie should land on the tone that says less.
 * The loser is reported in `alsoSaw` rather than dropped, so its refusals can still be applied.
 */
const TIE_ORDER: readonly Tone[] = ["urgent", "hesitant", "price_sensitive"];

export function detectTone(message: string): ToneReading {
  const scored = TONE_PROFILES.filter((t) => t.cues.length > 0)
    .map((t) => ({ tone: t.id, cues: cueHits(message, t.cues) }))
    .filter((s) => s.cues.length > 0)
    .sort((a, b) => {
      if (b.cues.length !== a.cues.length) return b.cues.length - a.cues.length;
      return TIE_ORDER.indexOf(a.tone) - TIE_ORDER.indexOf(b.tone);
    });

  if (scored.length === 0) return { tone: "neutral", cues: [], alsoSaw: [] };

  return {
    tone: scored[0].tone,
    cues: scored[0].cues,
    alsoSaw: scored.slice(1).map((s) => s.tone),
  };
}

/* ── Rendering ─────────────────────────────────────────────────────────────── */

/**
 * The tone block for the responder's prompt.
 *
 * Returns an empty array for `neutral` and whenever nothing fired, so the ordinary message
 * produces exactly the prompt it produced before this module existed.
 *
 * EVERY REFUSAL FROM EVERY TONE THAT FIRED is included, not only the winner's. A message that
 * is both price-sensitive and urgent must not get a speed promise merely because the price cues
 * outnumbered the urgency ones — the prohibitions are cumulative, and only the leading order
 * and the register come from the winner. Widening what is forbidden is always the safe
 * direction, and it is the same asymmetry lib/ai/pipeline.ts relies on.
 */
export function toneLines(reading: ToneReading): string[] {
  if (reading.tone === "neutral") return [];

  const winner = toneProfile(reading.tone);
  const lines: string[] = [
    "HOW THIS CUSTOMER IS WRITING, AND HOW TO ANSWER",
    `They sound ${reading.tone.replace(/_/g, " ")} — from their own words: ${reading.cues.join(", ")}.`,
    "",
    ...winner.register,
  ];

  if (winner.leadWith.length > 0) {
    lines.push(
      "",
      "Of the things you MAY promise above, lead with " +
        winner.leadWith.map((c) => CLAIM_LABEL[c]).join(", then ") +
        ".",
      "This changes the ORDER and the emphasis only. It does not add anything to that list, and",
      "the limit of at most two still applies.",
    );
  }

  /* Cumulative, winner last so its own prohibitions read closest to its instructions. */
  const refusals = [
    ...reading.alsoSaw.flatMap((t) => toneProfile(t).refuse),
    ...winner.refuse,
  ];

  if (refusals.length > 0) {
    lines.push("", "WITH THIS CUSTOMER IN PARTICULAR:", ...refusals);
  }

  return lines;
}
