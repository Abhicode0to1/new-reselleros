/**
 * The approval queue for what the agent learns — and the guardrail is the QUEUE'S TYPE.
 *
 * ─── THIS FEATURE COMPLETES THE OTHER FOUR, AND IT IS THE RIGHT ONE TO ASK FOR ─
 * `playbook.ts`, `reflection.ts`, `gold-standard.ts` and `loss-analysis.ts` all produce
 * candidates and all refuse to promote anything themselves. `decideTemplatePromotion` returns
 * `readyForReview` and stops; `suggestEmphasis` says how far off the sample is. Four modules
 * pointing at a screen that did not exist. This is that screen's logic.
 *
 * ─── BUT THE GUARDRAIL IS NOT THE REVIEWER'S ATTENTION ──────────────────────
 * The brief's own example is the failure exactly: a 90% discount given once, mistaken for a
 * winning pattern. And the important thing about that example is WHERE it has to be stopped.
 *
 * If the queue can contain "a new claim", then one careless click adds a claim. If the queue can
 * only ever contain an ORDERING among claims already authorised elsewhere, then no click —
 * careless, rushed, or malicious — can add one. THE REVIEWER IS THE SECOND LINE. The first line
 * is that there is nothing dangerous in the queue to approve.
 *
 * So `InsightKind` is a closed union of three safe kinds, and the kinds a reader would expect to
 * see are deliberately absent: no `new_claim`, no `price_change`, no `discount`, no `prompt_edit`.
 * A test asserts the union has not grown.
 *
 * And the 90% discount specifically never reaches this queue at all, because it is stopped twice
 * upstream: `screenHumanAnswer` blocks any answer containing a discount, and `redactLesson` keeps
 * no figures whatsoever. The guardrail the brief asks for already exists — this adds the second
 * line, which is the right place for a person.
 *
 * ─── AND ONE CLICK IS THE PROBLEM, NOT THE FEATURE ──────────────────────────
 * "Sales Manager bas 1-click [Approve Insight] dabata hai" describes the mechanism by which a
 * human in the loop stops being one. A row-level button on a list makes approval a scroll-and-tap
 * habit, and within a week it is rubber-stamping — at which point the queue is worse than no
 * queue, because it produces a record saying somebody checked.
 *
 * This codebase already knows that. `BulkBarConfirmButton` carries a four-second disarm because a
 * destructive action should not be one click, and `money-health-card.tsx` renders NOTHING when
 * healthy so that its appearance still means "stop and read". Same argument here: approval
 * requires the reviewer to have opened the item and to have been shown what it REPLACES, because
 * "lead with the GST invoice" means nothing until you know it displaces "lead with migration".
 *
 * ─── NOTHING IS PERMANENT ───────────────────────────────────────────────────
 * The brief says an approved rule becomes part of the AI's memory permanently. An ordering that
 * was right in August is wrong after a vendor price change or a new product, and an approval
 * nobody revisits is a decision with a date on it and no expiry. Every approval carries one.
 */
import { AUTHORISED_CLAIMS, type AuthorisedClaim } from "./tone";

/* ── What may be in the queue ─────────────────────────────────────────────── */

/**
 * The only kinds of insight that can exist. A CLOSED union, and that is the guardrail.
 *
 * `claim_ordering`      — which authorised claim to lead with. Cannot introduce a claim.
 * `objection_frequency` — what customers are pushing back on. A count, changes no behaviour.
 * `operational_alert`   — a dial, a domain, a rota. Points at a person, not at the prompt.
 *
 * Deliberately ABSENT, and a test asserts they stay absent: a new claim, a price, a discount, a
 * prompt edit, a template. Each of those is a thing one click should not be able to do, and the
 * way to guarantee that is for the queue to have no shape that holds it.
 */
export type InsightKind = "claim_ordering" | "objection_frequency" | "operational_alert";

export const INSIGHT_KINDS: readonly InsightKind[] = [
  "claim_ordering",
  "objection_frequency",
  "operational_alert",
] as const;

/** How long an approval stands before it must be looked at again. */
export const INSIGHT_EXPIRY_DAYS = 90;

/** Who may approve. Narrow on purpose — see `decideApproval`. */
export const APPROVER_ROLES: readonly string[] = ["owner", "manager"];

export interface Insight {
  kind: InsightKind;
  /**
   * What this would change, as identifiers. For `claim_ordering`, the claim to lead with.
   *
   * Typed as an authorised claim rather than a string, so the compiler refuses an insight that
   * names something else — the guardrail again, one level down.
   */
  leadWith: AuthorisedClaim | null;
  /**
   * What it REPLACES. Shown beside the change, because "lead with the GST invoice" means nothing
   * until the reviewer knows it displaces "lead with migration".
   */
  replaces: AuthorisedClaim | null;
  /** How many closed deals it is drawn from. The reviewer's denominator. */
  sampleSize: number;
  /** One plain sentence for the reviewer. Written by the app, never by a model. */
  summary: string;
}

/* ── Screening ────────────────────────────────────────────────────────────── */

export interface InsightScreening {
  queueable: boolean;
  reason: string;
}

/** Minimum sample before an insight is worth a reviewer's minute. */
export const MIN_SAMPLE_TO_QUEUE = 15;

/**
 * May this insight even enter the queue?
 *
 * ─── THE FIRST LINE, AND IT RUNS BEFORE ANY HUMAN SEES ANYTHING ─────────────
 * Screening at entry rather than at approval matters: a queue full of things that should not be
 * approved trains the reviewer to skim, and a skimming reviewer is the failure the whole feature
 * exists to prevent. Better that the queue is short and everything in it is a real decision.
 */
export function screenInsight(insight: Insight): InsightScreening {
  if (!INSIGHT_KINDS.includes(insight.kind)) {
    return {
      queueable: false,
      reason:
        `"${insight.kind}" is not a kind of insight this system has. The queue holds an ordering ` +
        "among claims that are already authorised, a count, or a pointer at an operational fix — " +
        "and nothing else, so that no approval can introduce a claim, a price or a discount.",
    };
  }

  if (insight.kind === "claim_ordering") {
    if (!insight.leadWith) {
      return { queueable: false, reason: "An ordering insight has to name what to lead with." };
    }
    if (!(AUTHORISED_CLAIMS as readonly string[]).includes(insight.leadWith)) {
      return {
        queueable: false,
        reason:
          `"${insight.leadWith}" is not on the authorised claim list, so this is not a reordering ` +
          "— it is a new claim wearing a reordering's clothes. Those do not go in a queue.",
      };
    }
    if (insight.replaces && !(AUTHORISED_CLAIMS as readonly string[]).includes(insight.replaces)) {
      return {
        queueable: false,
        reason: `"${insight.replaces}" is not on the authorised claim list either.`,
      };
    }
  }

  /* Any figure in the summary. The 90% discount from the brief cannot get this far — it is
     stopped by screenHumanAnswer and redactLesson upstream — and this is the belt: a summary is
     written by the app, so a number in one means something assembled it from a deal. */
  const figures = insight.summary.match(/(?<![\w.])\d{2,}\s*%|₹|\bRs\b/i);
  if (figures) {
    return {
      queueable: false,
      reason:
        `This summary contains "${figures[0]}". An insight carries counts and identifiers, never ` +
        "money and never a percentage off — a discount that worked once is the exact thing this " +
        "queue must not be able to make permanent.",
    };
  }

  if (insight.sampleSize < MIN_SAMPLE_TO_QUEUE) {
    return {
      queueable: false,
      reason:
        `Drawn from ${insight.sampleSize} ${insight.sampleSize === 1 ? "deal" : "deals"}, below ` +
        `the ${MIN_SAMPLE_TO_QUEUE} needed to be worth a decision. A queue full of things that ` +
        "should not be approved teaches the reviewer to skim, and a skimming reviewer is the " +
        "failure this whole queue exists to prevent.",
    };
  }

  return { queueable: true, reason: "" };
}

/* ── Approval ─────────────────────────────────────────────────────────────── */

export interface Reviewer {
  role: string;
  /** True only when the item was OPENED — not selected from a list. */
  openedTheItem: boolean;
  /** True only when the UI showed what this replaces, and the reviewer saw it. */
  sawWhatItReplaces: boolean;
}

export interface ApprovalDecision {
  approved: boolean;
  /** Days until this must be reviewed again. Null when nothing was approved. */
  expiresInDays: number | null;
  reason: string;
}

/**
 * May this insight be approved, by this person, right now?
 *
 * ─── ONE CLICK IS REFUSED, AND THAT IS THE POINT ────────────────────────────
 * `openedTheItem` and `sawWhatItReplaces` are the two conditions a row-level Approve button
 * cannot satisfy. They are not friction for its own sake: an ordering approved without seeing
 * what it displaces is an approval of half a change, and the reviewer would have no way to know
 * they had just moved migration out of first place.
 *
 * The role check is narrow — owner or manager — and it is a parameter rather than a rule, because
 * who signs off on what the company leads with is Pardeep's decision and not a default worth
 * burying in code. Five roles are live on this platform; two of them can approve.
 */
export function decideApproval(input: {
  insight: Insight;
  reviewer: Reviewer;
}): ApprovalDecision {
  const screening = screenInsight(input.insight);
  if (!screening.queueable) {
    return { approved: false, expiresInDays: null, reason: screening.reason };
  }

  if (!APPROVER_ROLES.includes(input.reviewer.role)) {
    return {
      approved: false,
      expiresInDays: null,
      reason:
        `A ${input.reviewer.role} cannot approve an insight. This changes what the agent says to ` +
        `every customer, so it is limited to ${APPROVER_ROLES.join(" or ")}.`,
    };
  }

  if (!input.reviewer.openedTheItem) {
    return {
      approved: false,
      expiresInDays: null,
      reason:
        "This was approved from the list without being opened. One click on a row is how a human " +
        "in the loop stops being one — within a week it is rubber-stamping, and then the queue is " +
        "worse than no queue because it produces a record saying somebody checked.",
    };
  }

  if (input.insight.kind === "claim_ordering" && !input.reviewer.sawWhatItReplaces) {
    return {
      approved: false,
      expiresInDays: null,
      reason:
        "The screen did not show what this replaces. 'Lead with the GST invoice' means nothing " +
        "until you know it displaces something else — approving it blind is approving half a " +
        "change.",
    };
  }

  return {
    approved: true,
    expiresInDays: INSIGHT_EXPIRY_DAYS,
    reason:
      `Approved, and it stands for ${INSIGHT_EXPIRY_DAYS} days. Nothing here is permanent: an ` +
      "ordering that was right today is wrong after a vendor price change or a new product, and " +
      "an approval nobody revisits is a decision with a date on it and no expiry.",
  };
}

/**
 * What this queue will never hold, with the reason.
 *
 * Data rather than prose so the empty state can say it — the most useful thing an empty approval
 * queue can tell a reviewer is what would never have appeared in it anyway.
 */
export const NEVER_QUEUED: readonly string[] = [
  "A new claim. The queue holds an ordering among claims already authorised in " +
    "SALES_AGENT_SYSTEM_PROMPT, so no approval can add one — the type has no shape for it.",
  "A price, a discount or any percentage off. The brief's own example — a 90% discount given " +
    "once and mistaken for a winning pattern — is stopped twice before this queue: " +
    "screenHumanAnswer blocks any answer containing a discount, and redactLesson keeps no " +
    "figures at all.",
  "An edit to any prompt. The prompt is where every guard lives, and a one-click change to it is " +
    "a one-click change to the guards.",
  "A verbatim message. Wording is how an unauthorised claim travels from a deal that closed to a " +
    "deal that has not, whoever approved it.",
  "Anything drawn from fewer than " +
    `${MIN_SAMPLE_TO_QUEUE} deals. A queue full of things that should not be approved teaches ` +
    "the reviewer to skim.",
];
