/**
 * Does this drafted reply COMMIT us to anything?
 *
 * ─── THE RULE STEP 2 RESTS ON ───────────────────────────────────────────────
 * The app may answer a customer by itself when the answer promises nothing. It may say
 * "got your enquiry", "which plan did you have in mind?", "when is a good time to call".
 * It may not say a price, a date, a discount or a guarantee — because those are the
 * sentences a customer can hold us to, and nobody read them before they left.
 *
 * This is the same shape as the auto-quote gate that works today: automation opens on a
 * FACT, not on a confidence score. "The model is 90% sure this is harmless" is an opinion;
 * "this text contains no figure, no date, no discount word and no guarantee" is checkable.
 *
 * ─── IT FAILS TOWARD HOLDING, AND THAT COSTS AUTOMATION RATE ────────────────
 * Every rule below is deliberately blunt. Any time word holds the reply, even in "thanks
 * for writing today", because a rule that tries to tell a commitment from a pleasantry is
 * the same widening trap the seat-count regex fell into — and there the cost was a missing
 * number, while here it is a promise nobody checked.
 *
 * The consequence is stated rather than hidden: this will hold replies it did not need to,
 * and the automation rate will be lower than the 60-70% estimate that motivated step 2.
 * THAT IS NOW MEASURABLE. Every hold is written to `ai_action_log` with the matched phrase
 * in its facts, so the first question to ask of that table in a week is which rule fires
 * most and whether its matches are real commitments. Tighten from data; do not guess now.
 *
 * ─── MONEY IS NOT RE-IMPLEMENTED HERE ───────────────────────────────────────
 * `verifyDraftMoney(text, [])` already finds every rupee figure in a string — with an empty
 * allow-list, every one of them is a violation. That function is tested, understands the
 * Indian forms (₹, Rs., lakh separators, the `/-` suffix) and is used by the human-facing
 * drafter. A second money regex here would be a second thing to be wrong.
 *
 * Note the difference in strictness from the human path, which is intentional. There,
 * a figure that IS on the deal is allowed, because a person is about to read the sentence
 * around it. Here NO figure is allowed at all: a correct number in a sentence the model
 * wrote can still commit us to something the quote does not say — "that price includes
 * migration" — and there is nobody to catch it.
 */
import { verifyDraftMoney } from "./money-guard";

export interface PromiseFinding {
  /** Which rule fired — goes into the log, so keep it readable. */
  kind: "money" | "date" | "discount" | "guarantee" | "percent";
  /** The words that fired it, so the operator sees WHAT was spotted. */
  matched: string;
}

export interface PromiseCheckResult {
  /** True only when nothing was found. */
  safe: boolean;
  findings: PromiseFinding[];
  /** One sentence for the log and for the operator. */
  reason: string;
}

/* ── Dates and deadlines ────────────────────────────────────────────────────
   A time is a commitment even when it sounds casual: "I'll send it by Friday" is a
   deadline somebody can miss. Vague futures are deliberately NOT here — "shortly" and
   "soon" promise nothing anyone can hold a stopwatch to, and they are what makes a safe
   acknowledgement possible at all. */
const DATE_RE = new RegExp(
  [
    String.raw`\b(?:today|tomorrow|tonight|yesterday)\b`,
    String.raw`\b(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)day\b`,
    String.raw`\b(?:eod|cob|end\s+of\s+(?:day|week)|close\s+of\s+business)\b`,
    String.raw`\b(?:with)?in\s+\d+\s*(?:hour|hr|day|week|month)s?\b`,
    /* ── THE HOLE THIS CLOSES, FOUND 25 AUG 2026 ─────────────────────────────
       The line above needs the preposition FIRST — "in 2 hours". Half the sentences this
       agent will actually write put the number first and the unit in Hindi:

           "aapke saare emails 2 ghante mein migrate kar denge"

       which is a duration promise in every sense that matters and matched nothing here. It
       came out of a brief asking the agent to say exactly that, and the guard would have let
       it through: a commitment somebody can hold a stopwatch to, made by a machine, about work
       whose length depends entirely on how many mailboxes there are and how big they are.

       Both orders are covered now, in Latin and in Hinglish. `ghanta`/`ghante`, `din`,
       `hafta`/`hafte`, `mahina`/`mahine` are the units that appear in real Hinglish sales
       writing; the bare English form ("2 hours", "3 working days") is added for the same
       reason — the preposition was never what made it a promise.

       ─── AND A DURATION IS NOT ALWAYS A PROMISE ──────────────────────────
       Broadening this caught something it should not have, immediately, in an existing test:

           "DNS changes can take up to 48 hours to propagate."

       That is not a commitment. It is a statement about how the internet works, and it is an
       upper BOUND that protects us rather than a deadline we could miss — the opposite end of
       the thing this rule is for. The original comment on this block already drew that line
       ("vague futures are deliberately NOT here"), and the fix is to keep drawing it: a
       duration introduced by "up to" or "takes" is describing somebody else's process, while
       "2 ghante mein kar denge" has us as the actor. The lookbehinds are what separate them.

       ─── AND A DURATION IN THE PAST IS A REPORT, NOT A PROMISE ────────────
       Found 25 Aug 2026 the same way the others were: a note this app writes about a FINISHED
       phone call — "Lasted about 4 minutes" — was refused by its own guard. It describes
       something that has already happened, so it cannot be a commitment in any reading. Same
       for "the migration took 3 days for a similar customer", which is the most useful honest
       thing the agent could say about a timeline.

       So `lasted`, `took`, `spent`, `ran for` and a bare `about` join the exemptions. The
       exemption is always on the word that makes the duration a REPORT, never on the number.

       A bare `about` is NOT one of those words, and the first version of this made it one — so
       "we will take about 3 days" walked straight through. `about` is exempt only when it
       follows a past-tense verb ("lasted about", "took about"). Caught by its own test.

       ─── AND `takes?` WAS EXEMPTING A COMMITMENT ──────────────────────────
       Measured while adding the above: "We will take 3 days." came back SAFE, and had done
       since this rule was written. The exemption was spelled `takes?`, which also matches the
       bare form — so every "we will take N days" was exempt. `takes` and `taking` describe a
       process; bare `take` does not. It is now exempt only after a modal ("can take", "may
       take"), which states a possibility. The honest DNS answer still goes out; the promise
       does not. */
    /* ── AND MINUTES WERE MISSING, FOUND 25 AUG 2026 ─────────────────────────
       The block above covers hours upward. It came out of a brief about migration, where hours
       is the natural unit, and the unit one step SMALLER was left open — so every one of these
       came back safe:

           "We can have your email running in 10 minutes."
           "10 minute mein setup ho jayega."
           "Setup in 30 seconds."
           "Response within 15 minutes, always."

       Two days, two briefs, two holes in the same rule, each in whatever unit that brief
       happened to use. The lesson recorded here for the next one: when a duration guard is
       widened, widen it across the whole ladder rather than to the example in hand.

       The last of those four is the one that had already slipped past in production shape. A
       draft is passed through `maskAuthorisedSellingPoints` BEFORE this runs, which rewrites
       "24/7" to "round-the-clock" because round-the-clock support is an authorised claim — so
       "our 24/7 phone support SLA is a 15 minute response" lost the only token being caught and
       went through with the SLA figure intact. Round-the-clock support is a promise we keep; a
       number next to it is a contract nobody signed.

       `\bmin\b` and `\bsec\b` only, never the bare prefixes: "minimum" and "second opinion"
       must not match, and a word boundary is what separates them. */
    String.raw`(?<!\bup\s+to\s)(?<!\btakes\s)(?<!\b(?:can|may|could|might)\s+take\s)(?<!\btaking\s)(?<!\blasted\s)(?<!\blasted\s+about\s)(?<!\btook\s)(?<!\btook\s+about\s)(?<!\bspent\s)(?<!\bspent\s+about\s)(?<!\bran\s+for\s)(?<!\bran\s+for\s+about\s)\b\d+\s*(?:ghante?a?|din|haft[ae]|mahin[ae]|minute?s?|mins?|second?s?|secs?)\b`,
    String.raw`(?<!\bup\s+to\s)(?<!\btakes\s)(?<!\b(?:can|may|could|might)\s+take\s)(?<!\btaking\s)(?<!\blasted\s)(?<!\blasted\s+about\s)(?<!\btook\s)(?<!\btook\s+about\s)(?<!\bspent\s)(?<!\bspent\s+about\s)(?<!\bran\s+for\s)(?<!\bran\s+for\s+about\s)\b\d+\s*(?:working|business)?\s*(?:hour|hr|day|week|month|minute|min|second|sec)s?\b(?=[^\w]*(?:me?in|me|within|and|,|\.|$|\s))`,
    /* Hindi day-words. `today`/`tomorrow`/`yesterday` are already unconditional on the first
       line of this list, and "aaj hi chalu kar denge" is the same commitment in the language
       this agent actually writes in — it was safe until now purely because the list was
       English. `parson` covers both day-after and day-before, as the word does.
       `abhi` is included but not when it is part of "abhi tak" or "abhi bhi", which describe
       the present state rather than commit to anything ("abhi tak nahi mila" is a complaint,
       not a promise). */
    String.raw`\b(?:aaj|kal|parson)\b`,
    String.raw`\babhi\b(?!\s+(?:tak|bhi))`,
    String.raw`\b(?:next|this|coming)\s+(?:week|month|monday|friday)\b`,
    /* 25 Aug · 25/08 · 2026-08-25 · 25th */
    String.raw`\b\d{1,2}\s*(?:st|nd|rd|th)?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)`,
    String.raw`\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b`,
    String.raw`\b\d{4}-\d{2}-\d{2}\b`,
    String.raw`\bby\s+(?:the\s+)?\d{1,2}\s*(?:st|nd|rd|th)\b`,
  ].join("|"),
  "i",
);

/* ── Discounts and giveaways ────────────────────────────────────────────────
   "free" is the trap. In this exact context "feel free to call me" is the commonest
   sentence in the language, so a bare \bfree\b would hold almost every safe reply — the
   feature would look built and never fire. Excluded by phrase, not by dropping the word:
   "first month free" has to keep holding. */
const DISCOUNT_RE = new RegExp(
  [
    String.raw`\bdiscount(?:s|ed|ing)?\b`,
    String.raw`\bwaiv(?:e|ed|er|ing)\b`,
    String.raw`\bcomplimentary\b`,
    String.raw`\bno\s+(?:charge|cost|extra)\b`,
    String.raw`\bat\s+no\s+cost\b`,
    String.raw`\b(?:special|best|lowest)\s+(?:price|rate|offer)\b`,
    String.raw`\b\d+\s*%\s*off\b`,
    String.raw`\bfree\s+of\s+(?:charge|cost)\b`,
    /* "free" on its own, EXCEPT the idiom. */
    String.raw`(?<!feel\s)(?<!feel\s{1,3})\bfree\b`,
  ].join("|"),
  "i",
);

/* ── Guarantees ─────────────────────────────────────────────────────────────
   Not about money or time — about certainty. "I'll make sure it works" is a promise with
   no number in it at all, and it is the kind a customer quotes back. */
const GUARANTEE_RE = new RegExp(
  [
    String.raw`\bguarantee(?:s|d)?\b`,
    String.raw`\bassur(?:e|ed|ance)\b`,
    String.raw`\bpromis(?:e|ed)\b`,
    String.raw`\bwarrant(?:y|ies)\b`,
    String.raw`\brefund(?:s|able|ed)?\b`,
    String.raw`\bmoney[\s-]?back\b`,
    String.raw`\b(?:we|i)\s+(?:will|'ll)\s+(?:ensure|make\s+sure|guarantee)\b`,
    String.raw`\bno\s+(?:risk|obligation)\b`,
  ].join("|"),
  "i",
);

/**
 * Any percentage at all. A rate is a commitment even without a currency symbol.
 *
 * NO trailing `\b` on the `%` branch, and that is not a style choice. `%` is a non-word
 * character, so `\b` after it demands a word character NEXT — which made "GST at 18%
 * applies" pass, because a space followed. The word forms keep their boundary, since
 * "percentage" is not "percent".
 */
const PERCENT_RE = /\b\d+(?:\.\d+)?\s*(?:%|percent\b|per\s*cent\b)/i;

export function findPromises(text: string): PromiseCheckResult {
  const body = (text ?? "").replace(/\r\n/g, "\n");
  const findings: PromiseFinding[] = [];

  /* Empty allow-list: on this path NO figure is authorised. Reusing the tested guard rather
     than writing a second money regex — see the header. */
  const money = verifyDraftMoney(body, []);
  if (!money.ok) {
    for (const v of money.violations) findings.push({ kind: "money", matched: v });
  }

  const pct = PERCENT_RE.exec(body);
  if (pct) findings.push({ kind: "percent", matched: pct[0].trim() });

  const date = DATE_RE.exec(body);
  if (date) findings.push({ kind: "date", matched: date[0].trim() });

  const disc = DISCOUNT_RE.exec(body);
  if (disc) findings.push({ kind: "discount", matched: disc[0].trim() });

  const gtee = GUARANTEE_RE.exec(body);
  if (gtee) findings.push({ kind: "guarantee", matched: gtee[0].trim() });

  if (findings.length === 0) {
    return {
      safe: true,
      findings: [],
      reason: "the reply promises nothing — no figure, date, discount or guarantee in it",
    };
  }

  /* The phrase, not just the category. An operator reading "held: date" learns nothing;
     "held — it said \"by Friday\"" tells them whether to send it as written. */
  const first = findings[0];
  return {
    safe: false,
    findings,
    reason:
      `the draft commits us to something — it says "${first.matched}"` +
      (findings.length > 1 ? ` (and ${findings.length - 1} more)` : "") +
      ". Read it and send it yourself, or edit it first.",
  };
}
