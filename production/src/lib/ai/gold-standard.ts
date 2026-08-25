/**
 * Learning from a colleague's answer — screened against the bar the agent already has to clear.
 *
 * ─── THIS ONE IS MORE DEFENSIBLE THAN THE OTHER TWO LEARNING LOOPS ──────────
 * lib/ai/playbook.ts refuses to keep wording from a won deal, and lib/ai/reflection.ts refuses
 * to let its output near a prompt. Both refusals turn on the same fact: the material is a
 * CUSTOMER'S text, and a customer is a stranger whose words must never become instructions.
 *
 * A human sales rep is not a stranger. Their answer is OUR words, written by somebody authorised
 * to speak for the company, and the takeover happens precisely when the agent got stuck — which
 * is exactly the case where there is something worth learning. Measured: `ai_action_log` holds 23
 * held actions, so this trigger genuinely fires and often. There is real material here.
 *
 * ─── AND THE DANGER IS DIFFERENT, AND SHARPER ───────────────────────────────
 * THE HUMAN'S ANSWER IS OFTEN GOOD BECAUSE THEY HAD AUTHORITY THE AGENT DOES NOT HAVE.
 *
 * A rep may commit to a date — "I'll have it with you Thursday". They may authorise a discount —
 * "leave it with me, I'll get you five percent". They may make a judgement call about a claim,
 * because a person carries the consequence. The agent may do none of those: `findPromises`
 * refuses a date, `discountedRate` only applies a published band, and every claim it makes has
 * to be on a list.
 *
 * So "the human's answer closed the deal" very often means THE HUMAN EXERCISED AUTHORITY. And
 * the "deal closed" filter selects precisely for those answers, because a commitment is what
 * closes a hesitant buyer. Saving the words as an agent template copies the PROMISE and leaves
 * the AUTHORITY behind — and the agent then makes commitments nobody can keep, in a voice that
 * sounds exactly like the colleague who could have kept them.
 *
 * ─── SO: ONE BAR, BOTH WRITERS ──────────────────────────────────────────────
 * A human answer becomes a candidate template only if it would have survived the guards the
 * agent's own draft has to survive — `findPromises`, `verifyDraftMoney`, `findDisparagement`.
 * The same functions, not new ones, because two bars drift and the whole point is that a template
 * is something the agent may send.
 *
 * That screening is useful to the rep as well as safe: "this closed because you committed to a
 * date, and that is yours to do rather than the agent's" is a better answer than a silent
 * rejection, and it is exactly what `screenHumanAnswer` returns.
 *
 * ─── AND A FIGURE BELONGS TO ITS OWN DEAL ───────────────────────────────────
 * Even an answer that clears every guard cannot be a template if it contains a rupee figure. The
 * money guard checks a figure against what was authorised FOR THAT DEAL; replaying it at another
 * customer would state deal A's price to customer B, which is both a disclosure and a figure from
 * outside the catalogue. Same reason playbook.ts keeps no numbers.
 *
 * ─── "PERMANENTLY" IS THE OTHER WORD TO REFUSE ──────────────────────────────
 * The brief says the answer is saved permanently. A price that was right in August is wrong after
 * a vendor change, and a "gold standard" holding a stale figure is a wrong answer with a good
 * name on it. Templates carry no figures at all (above), which removes most of that — and
 * promotion still needs a person, because the H in RLHF is a human in the loop, not a human
 * whose words were harvested.
 */
import { findPromises } from "./promise-check";
import { findDisparagement } from "./disparagement";
import { verifyDraftMoney } from "./money-guard";
import { containsInstructionText } from "./reflection";

/* ── Screening ────────────────────────────────────────────────────────────── */

/** Why a human answer cannot become an agent template. Each names the authority gap. */
export type Blocker =
  | "commits_to_a_date"
  | "offers_a_discount"
  | "makes_a_guarantee"
  | "states_a_figure"
  | "unauthorised_figure"
  | "runs_down_a_competitor"
  | "addresses_the_system"
  | "too_short_to_be_a_pattern";

export interface Screening {
  /** True only when NOTHING blocks it. Still not sufficient — a person must approve. */
  eligible: boolean;
  blockers: readonly Blocker[];
  /**
   * One paragraph for the rep who wrote it, in plain words.
   *
   * Written for THEM rather than for a log, because the interesting case is not "rejected" — it
   * is "this worked because you did something the agent is not allowed to do", which is worth
   * knowing whether or not a template comes out of it.
   */
  reason: string;
}

/** Below this many characters an answer is an acknowledgement, not a pattern worth keeping. */
export const MIN_ANSWER_CHARS = 80;

/** How a blocker reads to the person who wrote the answer. */
const BLOCKER_TEXT: Record<Blocker, string> = {
  commits_to_a_date:
    "it commits to a date or a duration — you can do that because you carry the consequence, " +
    "and the agent cannot",
  offers_a_discount:
    "it offers a discount or something free — a discount is yours to give, and the agent may " +
    "only apply the published volume band",
  makes_a_guarantee: "it guarantees something, which needs a person behind it",
  states_a_figure:
    "it states a rupee figure. That figure belongs to this deal — replayed at another customer " +
    "it would be their price stated wrongly, and a price from outside the catalogue is one the " +
    "money guard cannot check",
  unauthorised_figure:
    "it states a figure that was not authorised even on this deal, which is worth a second look " +
    "at the quotation as well",
  runs_down_a_competitor:
    "it runs down the customer's existing provider, which is a comparative claim about a named " +
    "company",
  addresses_the_system:
    "it contains text that reads as an instruction to the software rather than as a message to " +
    "the customer",
  too_short_to_be_a_pattern:
    "it is too short to be a pattern — a one-line acknowledgement does not tell the agent " +
    "anything it did not know",
};

/**
 * Would this human answer have been allowed if the agent had written it?
 *
 * @param answer the rep's message, as sent.
 * @param allowedMoney the figures authorised on THAT deal, for the money guard.
 */
export function screenHumanAnswer(answer: string, allowedMoney: readonly number[] = []): Screening {
  const text = answer.trim();
  const blockers: Blocker[] = [];

  if (text.length < MIN_ANSWER_CHARS) blockers.push("too_short_to_be_a_pattern");

  /* The agent's own promise guard, unmasked. `maskAuthorisedSellingPoints` is deliberately NOT
     applied: it exists so the agent's own authorised phrases are not refused in its own draft,
     and a human answer is being judged on whether it could become a TEMPLATE — where "free
     migration" is fine but "free for the first month" is not, and the mask cannot tell them
     apart outside the sentence it was written for. Screening the raw text is the strict
     direction, and strict is right when the output is reused. */
  const promises = findPromises(text);
  if (!promises.safe) {
    for (const f of promises.findings) {
      if (f.kind === "date" && !blockers.includes("commits_to_a_date")) {
        blockers.push("commits_to_a_date");
      } else if (f.kind === "discount" && !blockers.includes("offers_a_discount")) {
        blockers.push("offers_a_discount");
      } else if (f.kind === "guarantee" && !blockers.includes("makes_a_guarantee")) {
        blockers.push("makes_a_guarantee");
      }
    }
  }

  /* ANY figure blocks a template, authorised or not — see the header. The distinction between
     the two still reaches the rep, because an UNauthorised figure on a live deal is worth
     looking at the quotation over, and not only worth refusing a template for. */
  const money = verifyDraftMoney(text, allowedMoney);
  if (money.violations.length > 0) blockers.push("unauthorised_figure");
  else if (money.found.some((n) => n !== 0)) blockers.push("states_a_figure");

  if (!findDisparagement(text).clean) blockers.push("runs_down_a_competitor");
  if (!containsInstructionText(text).clean) blockers.push("addresses_the_system");

  if (blockers.length === 0) {
    return {
      eligible: true,
      blockers: [],
      reason:
        "This answer would have been allowed if the agent had written it, so it can be offered " +
        "as a pattern once somebody approves it.",
    };
  }

  return {
    eligible: false,
    blockers,
    reason:
      "This answer worked, and the agent still cannot reuse it: " +
      blockers.map((b) => BLOCKER_TEXT[b]).join("; ") +
      ". Nothing is wrong with what you sent — the agent is held to a narrower bar because " +
      "nobody reads its messages before they go.",
  };
}

/* ── Promotion ────────────────────────────────────────────────────────────── */

export interface Candidate {
  /** The rep's answer, kept for a PERSON to read. Never handed to a model unapproved. */
  answer: string;
  screening: Screening;
  /** Did the deal close after this answer? Recorded, and deliberately not a promotion rule. */
  dealClosed: boolean;
}

export interface PromotionVerdict {
  /** ALWAYS false. A person promotes; this function only ever says what is missing. */
  promote: false;
  /** True when it cleared the guards and is worth a person's minute. */
  readyForReview: boolean;
  reason: string;
}

/**
 * May this answer become an agent template on its own? No — and the type says so.
 *
 * ─── THE H IN RLHF IS A HUMAN IN THE LOOP, NOT A HUMAN WHOSE WORDS WERE TAKEN ─
 * `promote` is the literal `false`, so no caller can branch on a true case and no later edit can
 * add one without changing the type — the same shape `decidePromotion` uses in lib/ai/ab-test.ts,
 * and for a related reason. There, promotion would change what the company says to everybody on
 * the strength of a coin toss. Here it would change it on the strength of one deal, using words
 * whose author had authority the agent does not.
 *
 * `dealClosed` is recorded and is deliberately NOT part of the decision. It is the most tempting
 * signal available and the most misleading one: an answer that closed a deal by committing to a
 * date closed it BECAUSE of the commitment, so selecting on outcome selects for exactly the
 * answers the agent must not reuse.
 */
export function decideTemplatePromotion(candidate: Candidate): PromotionVerdict {
  if (!candidate.screening.eligible) {
    return {
      promote: false,
      readyForReview: false,
      reason: candidate.screening.reason,
    };
  }

  return {
    promote: false,
    readyForReview: true,
    reason:
      "This answer clears every guard the agent's own drafts have to clear, so it is worth a " +
      "minute of somebody's time. It does not become a template until a person says so — an " +
      "answer that worked once is a good candidate and not yet a rule." +
      (candidate.dealClosed
        ? " The deal did close afterwards, which is worth knowing and is not why it is being " +
          "offered: selecting on the outcome would pick out the answers that closed BECAUSE a " +
          "commitment was made, which are the ones the agent cannot reuse."
        : ""),
  };
}

/**
 * What must be true before a human answer becomes something the agent may send.
 *
 * Data rather than prose so the review screen can state each condition beside the answer, and so
 * a test can assert each is present rather than implied.
 */
export const PROMOTION_REQUIRES: readonly string[] = [
  "It clears the same guards an agent draft clears — the promise check, the money guard and the " +
    "disparagement check. One bar for both writers, using the same functions, because two bars " +
    "drift and a template is by definition something the agent may send.",
  "It contains no rupee figure at all. A figure belongs to the deal it was quoted on; replayed " +
    "at another customer it is their price stated wrongly, and a price from outside the " +
    "catalogue is one the money guard cannot check.",
  "It commits to no date, no duration and no discount. Those are a person's to give because a " +
    "person carries the consequence — and they are the commonest reason a human answer closes a " +
    "deal, which is why the outcome is not a promotion rule.",
  "A person has read it and approved it. The H in RLHF is a human in the loop, not a human whose " +
    "words were harvested.",
  "It is reviewed again when prices change. Nothing here is permanent — a gold standard holding " +
    "a stale fact is a wrong answer with a good name on it.",
];
