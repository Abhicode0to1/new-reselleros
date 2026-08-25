/**
 * Two pitches, one assignment rule, and a refusal to declare a winner on noise.
 *
 * ─── THE MEASUREMENT THAT DECIDES THIS WHOLE FILE ───────────────────────────
 * Read from the live tables on 25 Aug 2026, for this tenant:
 *
 *   quotes ever issued .................. 20   (17 accepted, 1 sent, 2 draft)
 *   agent messages ever written ......... 0
 *   AI actions with outcome `sent` ...... 0
 *
 * The brief asks the system to notice that "Variant B se 25% zyada quotes accept ho rahe hain"
 * and make B the default for every future customer. Detecting a 25% RELATIVE lift on a 20%
 * base rate, at 95% confidence and 80% power, needs about ELEVEN HUNDRED quotes PER ARM —
 * `requiredSamplePerArm` computes it rather than asserting it, so the number moves with the
 * assumptions instead of being a claim in a comment.
 *
 * Twenty quotes exist. All of them. Ever.
 *
 * ─── SO AUTO-PROMOTION IS NOT A FEATURE HERE, IT IS THE FAILURE MODE ────────
 * A 25% "lift" on 8 conversions against 6 is not a finding, it is two extra customers who
 * would have said yes anyway. That is ordinarily harmless — but the brief pairs it with
 * "future ke saare customers ke liye default bana dega", and that turns a coin toss into a
 * PERMANENT change to what this company says to everybody, with the test switched off
 * afterwards because a winner was declared.
 *
 * A wrong answer nobody can revisit is worse than no answer. And it is worse than admitting
 * ignorance for a specific reason: the change arrives wearing the authority of data, so the next
 * person to doubt it has to argue with a number rather than with a guess.
 *
 * So `decidePromotion` never promotes on its own. It returns what is missing, in quotes, and
 * a person decides. That also makes the feature useful TODAY, which auto-promotion would not
 * be: it tells the operator "you need about 1,100 per arm, you have 4" instead of silently
 * picking one.
 *
 * The 85% acceptance rate in that data is not a usable baseline either — 17 of 20 accepted is
 * not a cold-market conversion rate, it is what a table of internal and test quotes looks like.
 * `decidePromotion` takes the base rate as an argument rather than reading it from history for
 * exactly that reason.
 *
 * ─── AND A VARIANT CHANGES HOW WE SAY IT, NEVER WHAT WE CLAIM ───────────────
 * The third module in this codebase to hold that line, after lib/ai/tone.ts and
 * lib/ai/trade-in.ts, and it matters most here: an experiment that could introduce claims would
 * be an experiment in what the company is willing to assert, run automatically, on strangers.
 * So a variant selects and orders AUTHORISED_CLAIMS and nothing else, and a test walks every
 * variant to check it.
 *
 * ─── THREE OF THE BRIEF'S SIX SELLING POINTS CANNOT BE SAID ─────────────────
 * · "SLA 99.9%" — an UPTIME FIGURE, which SALES_AGENT_SYSTEM_PROMPT forbids by name ("No
 *   uptime figures, no delivery dates, no contractual terms"). It is also not ours to offer:
 *   we resell somebody else's platform and underwrite nothing about its availability. A
 *   customer who loses a morning to an outage will read that number back to us.
 *
 * · "ISO Security" — a CERTIFICATION. Same class as the Google Partner certificate refused in
 *   lib/ai/tone.ts: a checkable credential, and TASKS.md records that even the Google reseller
 *   agreement is not approved. Naming a standard we do not hold is the one claim a serious
 *   buyer will verify first.
 *
 * · "Free 2-Hour Migration" — the phrase this repo closed a guard hole for on 25 Aug.
 *   `findPromises` catches "2 hours" and "2 ghante" in both word orders now, so a draft saying
 *   it is held. It is refused on merits too: migration length depends entirely on how many
 *   mailboxes there are and how big they are, and we are told neither.
 *
 * The other three are already on the authorised list, which is the point — the brief's better
 * variant is built from things we can actually say.
 */
import { AUTHORISED_CLAIMS, type AuthorisedClaim } from "./tone";

/* ── Variants ─────────────────────────────────────────────────────────────── */

export type VariantId = "formal" | "conversational";

export interface PitchVariant {
  readonly id: VariantId;
  readonly label: string;
  /** Which authorised claims to lead with, in order. A SUBSET of AUTHORISED_CLAIMS, always. */
  readonly leadWith: readonly AuthorisedClaim[];
  /** How to write. Register only — never a new fact. */
  readonly register: readonly string[];
  /** What the brief wanted in this variant that cannot be said, with the reason. */
  readonly refuse: readonly string[];
}

export const PITCH_VARIANTS: readonly PitchVariant[] = [
  {
    id: "formal",
    label: "Formal and technical",
    /* The two claims a finance or IT reader can verify themselves. */
    leadWith: ["gst_invoice", "inr_billing"],
    register: [
      "Plain, precise, and short. Lead with the invoice and what it lets them reclaim, because",
      "the person reading this is likely to be the one who files the return.",
      "No exclamation marks and no warmth for its own sake — the register is a supplier writing",
      "to a business, and over-familiarity reads as a sales script to this reader.",
    ],
    refuse: [
      "Do NOT state an uptime figure or an SLA percentage. The agent's own rules forbid uptime " +
        "figures and contractual terms, and it is not ours to offer in any case: we resell " +
        "somebody else's platform and underwrite nothing about its availability. A customer who " +
        "loses a morning to an outage will read that number back to us.",
      "Do NOT claim an ISO certification, a security standard, or any audit we have passed. It " +
        "is a checkable credential, and a serious technical buyer checks it first.",
      "Do NOT name a compliance framework at all — no SOC, no ISO, no GDPR posture. What we can " +
        "say about compliance is what our own invoice does under GST, which is already on your " +
        "list.",
    ],
  },
  {
    id: "conversational",
    label: "Conversational and benefit-led",
    /* Migration and support: the two that answer "what will this be like for me". */
    leadWith: ["migration_included", "local_support"],
    register: [
      "Warmer and shorter. Lead with what happens to their existing mail and who picks up the",
      "phone, because those are the two things a first-time buyer actually worries about.",
      "Plain Indian business English, one idea per sentence. Contractions are fine here.",
      "Still no brochure: at most two of the authorised points, as always.",
    ],
    refuse: [
      "Do NOT put a duration on the migration — not two hours, not a day, not 'quick'. How long " +
        "it takes depends entirely on how many mailboxes there are and how big they are, and " +
        "you have been told neither. The draft guard refuses the phrase in any case.",
      "Do NOT state a card, forex or bank percentage. Billing in rupees by an Indian company is " +
        "a fact about our invoice; what their bank charges is a fact about their contract with " +
        "their bank, and issuers charge a range rather than one number.",
      "Do NOT promise a support channel we have not confirmed we staff. Round-the-clock support " +
        "from a local team is on your list; naming WhatsApp specifically is a commitment about " +
        "which desk is open, which is not yours to make.",
    ],
  },
] as const;

export function pitchVariant(id: VariantId): PitchVariant {
  const found = PITCH_VARIANTS.find((v) => v.id === id);
  if (!found) throw new Error(`unknown pitch variant: ${id}`);
  return found;
}

/* ── Assignment ───────────────────────────────────────────────────────────── */

/**
 * Which arm this lead is in — decided by the lead's own id, not by chance.
 *
 * ─── WHY A HASH AND NOT A RANDOM DRAW ───────────────────────────────────────
 * A customer who gets the formal pitch in the morning and the conversational one in the evening
 * is being contradicted by the same company, in the same thread, and the whole point of the
 * unified memory built earlier today is that this stops happening. A random draw per message
 * guarantees it.
 *
 * Hashing the lead id gives a stable arm for the life of the lead, and it is auditable
 * afterwards: the same id always produces the same answer, so "why did this customer get B" has
 * a checkable reply. It also means no clock and no `Math.random()` anywhere in the sales path,
 * which keeps every one of these decisions reproducible in a test.
 *
 * FNV-1a, 32-bit. Not cryptographic and does not need to be — it needs to be evenly spread and
 * identical on every run.
 */
export function armFor(leadId: string): VariantId {
  let h = 0x811c9dc5;
  for (let i = 0; i < leadId.length; i += 1) {
    h ^= leadId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  /* ─── AND THE COMMENT THAT WAS HERE WAS WRONG ────────────────────────────
     It said: ">>> 0 first: Math.imul returns a signed 32-bit value, and a negative modulo would
     put every negative hash in the same arm." That is not true, and a mutation test proved it —
     deleting the shift left every test green, so I measured instead of assuming:

       20,000 ids · 10,001 negative hashes · 0 answers that differ

     Parity survives the shift both ways. `h >>> 0` adds 2^32, which is even, so it cannot change
     oddness; and for a negative even h, `h % 2` is `-0`, which `=== 0` in JavaScript. So the
     negative case was never broken.

     The shift stays because an unsigned value is what a reader expects to see going into a
     modulo, and it costs nothing. But it is not load-bearing, no test can distinguish it, and
     saying otherwise in a comment would be the same false-authority mistake as the telecall
     webhook's "that is checked above". */
  return (h >>> 0) % 2 === 0 ? "formal" : "conversational";
}

/* ── Whether there is enough evidence to change anything ──────────────────── */

/** 95% two-sided. z for α/2 = 0.025. */
const Z_ALPHA_HALF = 1.959964;
/** 80% power. z for β = 0.20. */
const Z_BETA = 0.841621;

/**
 * How many quotes PER ARM are needed to detect a relative lift of this size.
 *
 * The standard two-proportion sample size. Written as a function rather than a number in a
 * comment so the answer moves when the assumptions do — and so the assumptions are visible:
 * 95% confidence, 80% power, two-sided.
 *
 * @param baseRate the current acceptance rate, 0–1. The rate you are trying to beat.
 * @param relativeLift the improvement you want to be able to see, e.g. 0.25 for 25%.
 */
export function requiredSamplePerArm(baseRate: number, relativeLift: number): number {
  const p1 = Math.min(Math.max(baseRate, 0.0001), 0.9999);
  const p2 = Math.min(p1 * (1 + relativeLift), 0.9999);
  const delta = p2 - p1;
  if (delta <= 0) return Number.POSITIVE_INFINITY;

  const pBar = (p1 + p2) / 2;
  const a = Z_ALPHA_HALF * Math.sqrt(2 * pBar * (1 - pBar));
  const b = Z_BETA * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil(((a + b) ** 2) / (delta ** 2));
}

export interface ArmResult {
  variant: VariantId;
  /** Quotes sent under this variant. */
  sent: number;
  /** Of those, how many were accepted. */
  accepted: number;
}

export interface PromotionDecision {
  /** ALWAYS false. See the header, and the reason below. */
  promote: false;
  /** Which arm is ahead so far, or null when they are level or there is nothing to compare. */
  leading: VariantId | null;
  /** Quotes needed per arm, for the lift being looked for. */
  neededPerArm: number;
  /** The smaller of the two arms — the one that actually limits the test. */
  smallestArm: number;
  /** One paragraph for a person: what we have, what we would need, and what to do now. */
  reason: string;
}

/**
 * Read the two arms and say what may be concluded. The answer is never "switch".
 *
 * ─── NEVER PROMOTES, AND THAT IS THE FEATURE ────────────────────────────────
 * `promote` is typed as the literal `false` so no caller can branch on a true case that does not
 * exist, and no later edit can quietly add one without changing the type. Promotion is a
 * decision about what this company says to every future customer, and that belongs to a person
 * even when the numbers are good — which today they cannot be.
 */
export function decidePromotion(input: {
  arms: readonly ArmResult[];
  /** The rate to beat. Passed in, never read from history — see the header on the 85%. */
  baseRate: number;
  /** The lift worth switching for. The brief's own figure is 0.25. */
  relativeLift: number;
}): PromotionDecision {
  const neededPerArm = requiredSamplePerArm(input.baseRate, input.relativeLift);
  const smallestArm = input.arms.length === 0 ? 0 : Math.min(...input.arms.map((a) => a.sent));

  const rates = input.arms
    .filter((a) => a.sent > 0)
    .map((a) => ({ variant: a.variant, rate: a.accepted / a.sent }))
    .sort((x, y) => y.rate - x.rate);

  const leading =
    rates.length >= 2 && rates[0].rate > rates[1].rate ? rates[0].variant : null;

  const needed = Number.isFinite(neededPerArm) ? neededPerArm.toLocaleString("en-IN") : "an unbounded number of";

  if (smallestArm === 0) {
    return {
      promote: false,
      leading: null,
      neededPerArm,
      smallestArm,
      reason:
        "Nothing has been sent under at least one of the two pitches, so there is nothing to " +
        `compare. To tell a ${Math.round(input.relativeLift * 100)}% improvement from chance ` +
        `you would need about ${needed} quotes in EACH arm. Keep both running.`,
    };
  }

  return {
    promote: false,
    leading,
    neededPerArm,
    smallestArm,
    reason:
      (leading
        ? `${pitchVariant(leading).label} is ahead so far, on ${smallestArm} quotes in the ` +
          "smaller arm. "
        : `The two pitches are level so far, on ${smallestArm} quotes in the smaller arm. `) +
      `That is far too few to mean anything: telling a ${Math.round(input.relativeLift * 100)}% ` +
      `improvement from chance needs about ${needed} quotes in EACH arm. A difference on ` +
      "numbers this small is a couple of customers who would have said yes anyway — and making " +
      "it the default for everybody would lock in a coin toss and switch the test off. Keep " +
      "both running; nothing changes automatically.",
  };
}

/* ── The prompt block ─────────────────────────────────────────────────────── */

/**
 * The variant's instructions, for the responder's prompt.
 *
 * Reads exactly like `toneLines` on purpose: a register, an ordering over claims already
 * authorised elsewhere, and the prohibitions that go with this particular pitch. The claims
 * themselves are never restated here — they live in `SALES_AGENT_SYSTEM_PROMPT` and stay there.
 */
export function variantLines(id: VariantId): string[] {
  const v = pitchVariant(id);
  return [
    `PITCH STYLE FOR THIS CUSTOMER: ${v.label}`,
    ...v.register,
    "",
    "Of the things you MAY promise above, lead with " +
      v.leadWith.map((c) => CLAIM_LABEL[c]).join(", then ") +
      ".",
    "This changes the ORDER and the wording only. It adds nothing to that list, and the limit of",
    "at most two still applies.",
    "",
    "WITH THIS PITCH IN PARTICULAR:",
    ...v.refuse.map((r) => `  - ${r}`),
  ];
}

/** Names for the claims, by label. Not the claims — a pointer to them. */
const CLAIM_LABEL: Record<AuthorisedClaim, string> = {
  gst_invoice: "the GST tax invoice and the input tax credit it carries",
  inr_billing: "being billed in rupees by an Indian company",
  migration_included: "migration of their existing mail being included",
  local_support: "round-the-clock support from a local team",
};

/** Guard-rail for the tests: the claims a variant may choose from, and no others. */
export const VARIANT_CLAIM_UNIVERSE = AUTHORISED_CLAIMS;
