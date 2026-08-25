/**
 * What the AI actually did, for the person who has to decide whether to trust it more.
 *
 * ─── THE MEASUREMENT THAT DECIDED THE SHAPE OF THIS FILE ────────────────────
 * Read from the live `ai_action_log` on 25 Aug 2026, all 34 rows it has ever held:
 *
 *   reply.send          held     19
 *   reply.send          failed    8
 *   support.reply.send  held      4
 *   quote.send          skipped   2
 *   dunning.send        failed    1
 *
 * THERE IS NO `sent`. Not one, ever. The agent has drafted thirty-odd messages and every single
 * one was held by a dial, refused by a guard, or lost to a model that returned nothing.
 *
 * So an "AI Conversion Rate" today has a structurally empty numerator, and a "Revenue Generated
 * by AI" is zero — not small, zero. Any figure above zero on that tile would be attribution
 * fiction, and it is the flattering kind: the agent now touches nearly every inbound enquiry, so
 * "revenue on deals the AI was involved in" tends toward TOTAL revenue while the AI's actual
 * contribution was one held draft in a chain a person closed. A founder deciding how much to
 * trust the automation would be reading their own team's work with a robot's name on it.
 *
 * ─── SO: ZERO SENDS MEANS null, NOT 0% ──────────────────────────────────────
 * `conversionRate` and `revenueTouched` return null while `sent` is zero, because the two
 * readings have OPPOSITE fixes. "0%" reads as "the AI is not working" and sends somebody to look
 * at prompts. The truth is "the AI has never been allowed to finish anything" and the fix is a
 * dial, or a verified sending domain. A number that points at the wrong repair is worse than no
 * number — the same call `saas-charts.ts` makes for retention velocity below two cohorts.
 *
 * ─── WHAT IS WORTH SHOWING INSTEAD, TODAY ───────────────────────────────────
 * The funnel and the reason. `drafted → held/failed → sent → replied` with the commonest block
 * named in words is the honest headline, because every one of those held reasons is a decision
 * somebody can act on. From the same live read:
 *
 *   · "no setting for this action, so its default 'hold' applies"     → turn a dial
 *   · "replies are set to 'hold' for this workspace"                  → turn a dial
 *   · "60 seats is above the 50-seat ceiling for automatic quoting"   → working as designed
 *   · "it says '24/7'; 'free'"                                        → the mask incident
 *   · "names a price we did not authorise (Rs 1,24,416)"              → the money guard, working
 *   · "it says 'Rs 864'"                                             → the twelve-times unit bug
 *   · "send failed — Resend 403 … verify a domain"                    → verify the domain
 *
 * That last one is not a guard. It is a live delivery blocker found in this data: on 25 Aug a
 * dunning mail failed because the Resend account can only send to the account owner's own
 * address until a domain is verified. Worth stating plainly on the tile rather than counted as
 * an AI failure, because nothing about the draft was wrong.
 */
import { detectObjections, type ObjectionId } from "./battlecards";

/* ── The funnel ───────────────────────────────────────────────────────────── */

/** Outcomes `logAiAction` writes. `sent` is the only one that reached a customer. */
export type AiOutcomeName = "sent" | "held" | "failed" | "skipped";

export interface AiActionRow {
  action: string;
  outcome: string;
  reason: string | null;
  /** ISO timestamp. Only used for windowing by the caller; this module does not read a clock. */
  createdAt: string;
}

export interface AiFunnel {
  /** Every action the agent logged — the true denominator. */
  drafted: number;
  sent: number;
  held: number;
  failed: number;
  /** Switched off, or the kill switch. Not a failure and not a hold — a deliberate no. */
  skipped: number;
  /**
   * The commonest thing standing in the way, in the words the log already used.
   *
   * Null when nothing is being blocked. Deliberately the raw reason string rather than a
   * category: `logAiAction`'s reasons are written for a non-engineer (§24) and re-summarising
   * them here would replace a sentence somebody can act on with a label they cannot.
   */
  topBlock: { reason: string; count: number } | null;
}

export function aiFunnel(rows: readonly AiActionRow[]): AiFunnel {
  const count = (o: string) => rows.filter((r) => r.outcome === o).length;

  const blocked = rows.filter((r) => r.outcome === "held" || r.outcome === "failed");
  const tally = new Map<string, number>();
  for (const r of blocked) {
    const reason = r.reason?.trim();
    if (reason) tally.set(reason, (tally.get(reason) ?? 0) + 1);
  }

  /* Ties broken by the reason text so the tile does not reshuffle between two equal counts on
     every refresh — a number that moves without the data moving reads as a bug. */
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  return {
    drafted: rows.length,
    sent: count("sent"),
    held: count("held"),
    failed: count("failed"),
    skipped: count("skipped"),
    topBlock: top ? { reason: top[0], count: top[1] } : null,
  };
}

/* ── Conversion ───────────────────────────────────────────────────────────── */

export interface AiConversion {
  /**
   * Leads where an AI message actually REACHED the customer, and which of those converted.
   *
   * Null when nothing has ever been sent — see the header. The distinction is the whole point:
   * "0%" and "never allowed to try" send somebody to fix two different things.
   */
  rate: number | null;
  /** The numerator and denominator, always, so the rate can be checked rather than believed. */
  reached: number;
  converted: number;
  /** Why the rate is null, in words, when it is. Empty otherwise. */
  unavailable: string;
}

export function aiConversion(input: {
  /** Leads that received at least one AI message with outcome `sent`. */
  leadsReached: number;
  /** Of those, how many have a paid invoice. Must be a subset — asserted below. */
  leadsConverted: number;
}): AiConversion {
  const reached = Math.max(0, Math.trunc(input.leadsReached));
  /* Clamped to `reached` rather than trusted. A converted count above the reached count would
     produce a rate above 100% on a founder's dashboard, and the arithmetic that produced it
     lives in a SQL query two files away where nothing type-checks the relationship. */
  const converted = Math.min(reached, Math.max(0, Math.trunc(input.leadsConverted)));

  if (reached === 0) {
    return {
      rate: null,
      reached: 0,
      converted: 0,
      unavailable:
        "The AI has not sent a message to a customer yet, so it has had no chance to convert " +
        "anybody. This is not a low score — there is nothing to score. See what is holding it.",
    };
  }

  return { rate: converted / reached, reached, converted, unavailable: "" };
}

/* ── Revenue ──────────────────────────────────────────────────────────────── */

export interface AiRevenue {
  /**
   * Whole rupees received on deals the AI actually messaged. TOUCHED, never "generated".
   *
   * ─── WHY THE WORD MATTERS MORE THAN THE NUMBER ──────────────────────────
   * The brief asked for "Revenue Generated by AI". There is no honest way to compute that:
   * the AI drafts, a person reviews, the customer decides, and attributing the rupees to any
   * one of the three is a choice rather than a measurement. What CAN be measured is whether an
   * AI message reached the customer on a deal that later got paid — which is association and
   * is labelled as association everywhere it is shown.
   *
   * `sentCount` travels with it for exactly that reason. A rupee figure on its own invites
   * causation; a rupee figure next to "from 0 messages actually sent" cannot be misread.
   */
  touchedRupees: number | null;
  /** How many AI messages reached a customer across those deals. Zero makes the figure null. */
  sentCount: number;
  unavailable: string;
}

export function aiRevenue(input: {
  /** Whole rupees of payments on leads the AI messaged. Rupees, not paise (AGENTS.md §1). */
  paidRupees: number;
  sentCount: number;
}): AiRevenue {
  const sentCount = Math.max(0, Math.trunc(input.sentCount));

  if (sentCount === 0) {
    return {
      touchedRupees: null,
      sentCount: 0,
      unavailable:
        "No AI message has reached a customer yet, so no revenue can be associated with one. " +
        "A figure here today would be this team's own work with the AI's name on it.",
    };
  }

  return {
    touchedRupees: Math.max(0, Math.round(input.paidRupees)),
    sentCount,
    unavailable: "",
  };
}

/* ── Objections ───────────────────────────────────────────────────────────── */

/**
 * Below this many customer messages, the list is not ranked.
 *
 * Three objections out of eleven messages is not "the top objection is price", it is four
 * people. Naming a leader on a handful invites a pricing decision made on noise — and the live
 * table holds FIFTEEN customer turns in total, so this threshold is not theoretical today.
 */
export const MIN_MESSAGES_FOR_OBJECTIONS = 25;

export interface ObjectionTally {
  id: ObjectionId;
  label: string;
  count: number;
  /** Share of the messages that raised any objection. Rounded for display, not for maths. */
  share: number;
}

export interface ObjectionSummary {
  /** Ranked, commonest first. EMPTY while the sample is below the threshold. */
  top: readonly ObjectionTally[];
  /** How many customer messages were read. Always shown next to the list. */
  messagesRead: number;
  /** How many of those raised at least one recognised objection. */
  messagesWithObjection: number;
  /** Why the list is empty, in words, when it is. Empty string otherwise. */
  unavailable: string;
}

/**
 * What customers are pushing back on, counted from their own messages.
 *
 * ─── THE TAXONOMY IS THE BATTLECARDS', NOT A SECOND ONE ─────────────────────
 * `detectObjections` is the same function the prompt uses to decide which battlecard to load,
 * so what gets COUNTED here and what gets ANSWERED there cannot drift. A separate list of
 * objection keywords for reporting would eventually rank an objection the agent has no card
 * for, and nobody would notice which of the two lists was stale.
 *
 * One message can raise two objections ("Zoho is cheaper and I'll buy direct") and is counted
 * under both, so the counts sum to more than `messagesWithObjection`. That is correct — a
 * dashboard that forced a message into one bucket would undercount the second objection every
 * time it appeared alongside the first.
 */
export function topObjections(customerMessages: readonly string[]): ObjectionSummary {
  const messagesRead = customerMessages.length;
  const tally = new Map<ObjectionId, { label: string; count: number }>();
  let withObjection = 0;

  for (const message of customerMessages) {
    const found = detectObjections(message);
    if (found.length === 0) continue;
    withObjection += 1;
    for (const card of found) {
      const prev = tally.get(card.id);
      tally.set(card.id, { label: card.objection, count: (prev?.count ?? 0) + 1 });
    }
  }

  if (messagesRead < MIN_MESSAGES_FOR_OBJECTIONS) {
    return {
      top: [],
      messagesRead,
      messagesWithObjection: withObjection,
      unavailable:
        `Only ${messagesRead} customer ${messagesRead === 1 ? "message" : "messages"} so far. ` +
        `Ranking objections needs at least ${MIN_MESSAGES_FOR_OBJECTIONS} — below that the ` +
        "order is a handful of people, and a pricing decision made on it would be a decision " +
        "made on noise.",
    };
  }

  const top = [...tally.entries()]
    .map(([id, v]) => ({
      id,
      label: v.label,
      count: v.count,
      share: withObjection === 0 ? 0 : v.count / withObjection,
    }))
    /* Count first, then label, so equal counts hold a stable order between refreshes. */
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return { top, messagesRead, messagesWithObjection: withObjection, unavailable: "" };
}
