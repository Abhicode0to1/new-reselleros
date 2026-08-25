/**
 * Refusing a draft that runs down the customer's current provider.
 *
 * ─── WHY THIS GUARD DID NOT EXIST UNTIL NOW ─────────────────────────────────
 * `MIGRATION_CLAIMS_FORBIDDEN` has said "who their DNS host should be, or that their current
 * provider is bad" since the day the domain lookup landed. That is a PROMPT INSTRUCTION, and a
 * prompt instruction is not a guard: measured 25 Aug 2026, the sentence
 *
 *     "Your legacy GoDaddy setup is outdated."
 *
 * came back SAFE from every check on the draft path. It is not a promise, it names no figure,
 * it commits to no date — so `findPromises` has nothing to say about it and it goes out.
 *
 * It came out of a brief that framed GoDaddy, Rediffmail, Hostinger and Webmail as "legacy
 * providers" and asked the agent to sell against them on that basis. The framing is the thing
 * that needed a guard, not the offer attached to it.
 *
 * ─── WHY IT MATTERS MORE THAN RUDENESS ──────────────────────────────────────
 * Three reasons, in the order they cost us:
 *
 *   1. THE CUSTOMER CHOSE IT. Somebody on GoDaddy usually bought their domain and mail as one
 *      thing from one company on purpose. Telling them that decision was bad is telling them
 *      they were careless, in the first mail we ever send them.
 *
 *   2. IT IS A COMPARATIVE CLAIM ABOUT A NAMED COMPANY. In India that is not free speech in a
 *      sales mail — the ASCI code covers denigration, and Trade Marks Act s.29(8) covers use of
 *      a mark in a way that damages its reputation. A machine generating those sentences at
 *      volume, in the company's name, is a liability nobody signed off.
 *
 *   3. WE CANNOT SEE WHAT WE ARE CRITICISING. The agent knows one thing about their setup: what
 *      the MX record says. "Outdated" and "insecure" are conclusions about software versions,
 *      configuration and support arrangements it has never looked at. It is the same error as
 *      guessing a provider from an unrecognised record, one step further along.
 *
 * ─── DELIBERATELY NARROW, AND THAT IS THE DESIGN ────────────────────────────
 * This catches UNAMBIGUOUS denigration and nothing else, because a guard that refuses the
 * company's own authorised phrases kills the feature it protects. That already happened here
 * once: `findPromises` refused "24/7" and "free" — both explicitly authorised by the agent's
 * own prompt — so every reply using the real selling points handed over, and the machinery was
 * alive while the feature was dead (see `maskAuthorisedSellingPoints`).
 *
 * So words that are entangled with legitimate drafting are LEFT OUT on purpose:
 *
 *   · "basic"    — "Microsoft 365 Business Basic" is a product name
 *   · "cheap(er)"— the customer's own objection is "Zoho is cheaper", and the battlecard tells
 *                  the agent to answer it; a draft discussing a cheaper plan is doing its job
 *   · "old"      — "your old mailboxes will be migrated" is operational, not an insult
 *   · "limited"  — "Private Limited" is in half the company names in this market
 *
 * The soft cases stay with the prompt instruction. This file is the floor, not the ceiling.
 */
import { PROVIDER_BRANDS } from "@/lib/dns/domain-inspect";

/**
 * Words that cannot be attached to somebody's existing setup without running it down.
 *
 * Every one of these is a CONCLUSION about software the agent has never seen. See the header
 * for the words deliberately absent and why each of them would break a legitimate draft.
 */
const PEJORATIVES: readonly string[] = [
  "legacy",
  "outdated",
  "out of date",
  "obsolete",
  "antiquated",
  "primitive",
  "prehistoric",
  "stone age",
  "unreliable",
  "insecure",
  "unsafe",
  "vulnerable",
  "inferior",
  "substandard",
  "amateur",
  "amateurish",
  "unprofessional",
  "no longer supported",
  "behind the times",
  /* Hinglish. The agent writes in it, so a guard that only reads English is a guard with a
     door in it — the same gap the promise check had with "aaj hi" until this week. */
  "purana",
  "puraana",
  "ghatiya",
  "bekaar",
  "bekar",
  "faltu",
  "kaam ka nahi",
];

/**
 * Ways a draft refers to what the customer has now, without naming a brand.
 *
 * Needed because "your current provider is insecure" is the same claim as "GoDaddy is
 * insecure" and mentions nobody. Neutral words only — "existing mail and data" is in the
 * authorised migration claim, so `existing` alone must never be a hit; it is the pejorative in
 * the same sentence that makes it one.
 */
const CURRENT_SETUP_REFS: readonly string[] = [
  "current provider",
  "current host",
  "current setup",
  "current system",
  "current email",
  "current mail",
  "existing provider",
  "existing host",
  "existing setup",
  "existing system",
  "present provider",
  "previous provider",
  "old provider",
  "abhi ka provider",
  "purana provider",
];

export interface DisparagementFinding {
  /** The brand or reference the sentence is about. */
  subject: string;
  /** The word that made it disparagement. */
  term: string;
  /** The sentence it appeared in, trimmed, for the operator's log. */
  sentence: string;
}

export interface DisparagementResult {
  clean: boolean;
  findings: readonly DisparagementFinding[];
  /** One sentence for the timeline. Names what was said and why it is being held. */
  reason: string;
}

/** Whole-word containment on a normalised string. Punctuation becomes space, so "GoDaddy." hits. */
function has(haystack: string, needle: string): boolean {
  return haystack.includes(` ${needle} `);
}

/**
 * Does this draft run down what the customer already has?
 *
 * SENTENCE BY SENTENCE, not whole-text. "Your mail is currently handled by GoDaddy. Our own
 * platform is not outdated." is two innocent sentences that a whole-text check would read as
 * one accusation — and the first of those is the exact observation `inspectionFacts` is built
 * to produce, so a whole-text check would refuse yesterday's feature.
 */
export function findDisparagement(text: string): DisparagementResult {
  const findings: DisparagementFinding[] = [];

  /* Splitting on the punctuation KEEPS it (lookbehind), the same way
     maskAuthorisedSellingPoints splits, so a sentence's own boundary cannot be lost. */
  for (const raw of text.split(/(?<=[.!?\n])/)) {
    const norm = ` ${raw.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim()} `;
    if (norm.trim().length === 0) continue;

    const term = PEJORATIVES.find((p) => has(norm, p));
    if (!term) continue;

    const brand = PROVIDER_BRANDS.find((b) => has(norm, b.toLowerCase()));
    const ref = CURRENT_SETUP_REFS.find((r) => has(norm, r));
    const subject = brand ?? ref;
    if (!subject) continue;

    findings.push({ subject, term, sentence: raw.trim() });
  }

  if (findings.length === 0) {
    return {
      clean: true,
      findings: [],
      reason: "the draft does not run down anybody's existing setup",
    };
  }

  /* §24: what happened, why, and what to do. The operator gets the actual words, because the
     fix is almost always to delete one adjective and send the rest. */
  const said = findings.map((f) => `"${f.term}" about ${f.subject}`).join("; ");
  return {
    clean: false,
    findings,
    reason:
      `The draft runs down what the customer already has — it says ${said}. We can only see ` +
      `their MX record, not their configuration, and this is the decision they made themselves. ` +
      `Remove the judgement and the rest of the reply can go.`,
  };
}
