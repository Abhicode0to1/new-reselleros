/**
 * The follow-up cadence — four touches over a week, and what each one is allowed to say.
 *
 * Pure. `sales-loops.ts` decides whether a scheduled nudge is still WANTED (the customer
 * replied, the deal closed, a person took over); this decides what the NEXT one is and when.
 * Two separate questions that both used to be answered by "one follow-up, some hours later".
 *
 * ─── ONE PENDING ROW, NOT FOUR ──────────────────────────────────────────────
 * `ai_sales_loops` carries a unique index allowing one pending nudge per lead, and its comment
 * explains why: two inbound messages a minute apart would otherwise schedule two follow-ups
 * and the customer gets nudged twice for one silence. Writing four rows on day one would have
 * meant dropping that.
 *
 * So the cadence advances a `step` instead. Firing step N marks the row processed and writes
 * step N+1. Beyond preserving the index this buys something better: every step re-reads the
 * world when it fires. Four rows written on day one would carry day-one assumptions to day
 * seven — the quote's expiry date, the lead's stage, whether a person has taken it over.
 *
 * ─── WHAT EACH STEP MAY CLAIM ───────────────────────────────────────────────
 * The cadence was specified with three claims this module does not make, for the same reason
 * lib/pricing/net-cost.ts makes none of its three:
 *
 *   · "Case Study: humne 50-user migration 0 downtime mein complete kiya" — a factual claim
 *     about work this company did, with no case study anywhere in the app to draw it from.
 *     Generating one is inventing a customer reference. The step carries the tenant's OWN
 *     words (`tenants.followup_value_drop`) or it is skipped.
 *   · "Special ₹262/seat promotional price" — ₹262 is the hardcoded per-month Starter figure
 *     again (AGENTS.md L106), and a volume slab is a published rate card, not a promotion.
 *     The rate does not expire; the QUOTE does. Prices come from the quote, never from here.
 *   · "quote kal expire ho raha hai" — read from `quotes.expires_date`, never asserted. The
 *     window is seven days today and a future change would turn an asserted "tomorrow" into a
 *     lie nobody would think to look for.
 */

export type CadenceChannel = "email" | "whatsapp";

export interface CadenceStep {
  /** 1-based, matching `ai_sales_loops.step`. */
  step: number;
  /** Days after the QUOTE, not after the previous step — see nextStepAt. */
  dayOffset: number;
  /** What this touch wants to go out on. WhatsApp may fall back — see resolveChannel. */
  channel: CadenceChannel;
  /** Short slug for the log and the timeline. */
  kind: "quote" | "check_in" | "value" | "expiry";
  /**
   * What the agent is being asked to write. An INTENT, not a script: the words come from the
   * model with the usual guards on them, because a hardcoded four-message sequence read back
   * to a customer who replied in between is worse than a machine that improvises politely.
   */
  intent: string;
  /** True when the step cannot fire without tenant-written content. */
  requiresContent?: boolean;
}

/**
 * The sequence. Day offsets are from the quote, so a slipped cron does not compress the tail.
 *
 * Day 1 is the quote itself and is listed for completeness — it is sent by the quote path, not
 * by the cron, which is why the cron starts scheduling at step 2.
 */
export const CADENCE: readonly CadenceStep[] = [
  {
    step: 1, dayOffset: 0, channel: "email", kind: "quote",
    intent: "The quote itself, with the covering note and the net-cost block.",
  },
  {
    step: 2, dayOffset: 2, channel: "whatsapp", kind: "check_in",
    intent:
      "A short check-in. Ask whether they had a chance to look at the quote and whether any " +
      "question came up. Do not restate the price, do not add urgency, and do not ask twice " +
      "for something they have already answered.",
  },
  {
    step: 3, dayOffset: 4, channel: "email", kind: "value", requiresContent: true,
    intent:
      "Share the reseller's own migration write-up, as given, and offer to walk them through " +
      "what their own migration would look like. Add nothing to the write-up: it describes " +
      "work the company actually did and you were not there.",
  },
  {
    step: 4, dayOffset: 7, channel: "email", kind: "expiry",
    intent:
      "Remind them the QUOTE expires on the date given, and offer to reissue it if they need " +
      "longer. The volume rate is a published rate card and does not expire — do not imply " +
      "the price is going away, and do not invent a discount deadline.",
  },
];

/** The step after this one, or null when the cadence is finished. */
export function nextStep(step: number): CadenceStep | null {
  return CADENCE.find((s) => s.step === step + 1) ?? null;
}

export function stepAt(step: number): CadenceStep | null {
  return CADENCE.find((s) => s.step === step) ?? null;
}

/**
 * When a step should fire, measured from the QUOTE rather than from the previous send.
 *
 * That choice matters when the cron slips. Chaining "+2 days from the last one" lets a missed
 * Saturday run push the whole tail later and later; anchoring to the quote keeps day 7 on day
 * 7. A step whose moment has already passed fires on the next run rather than being skipped —
 * late is better than never for a nudge, and `shouldNudge` will refuse it anyway if the world
 * has moved on.
 */
export function nextStepAt(quotedAt: Date, step: number): Date | null {
  const next = nextStep(step);
  if (!next) return null;
  return new Date(quotedAt.getTime() + next.dayOffset * 86_400_000);
}

/* ── Channel ─────────────────────────────────────────────────────────────── */

/** Meta's customer-service window: free-form WhatsApp is only allowed inside it. */
export const WHATSAPP_WINDOW_HOURS = 24;

export type ChannelDecision =
  | { channel: CadenceChannel; note: null }
  | { channel: CadenceChannel; note: string };

/**
 * What can actually carry this step.
 *
 * ─── THE 24-HOUR WINDOW IS NOT OPTIONAL, IT IS META'S ───────────────────────
 * A free-form WhatsApp message more than 24 hours after the customer's last message is
 * REFUSED by the API — error 131047 — unless it is a pre-approved template. The day-2 check-in
 * is, by construction, about 48 hours after the enquiry. So as specified it would simply
 * bounce, and the customer would get nothing at all.
 *
 * Falling back to email is the honest handling: the step still happens, the customer still
 * hears from us, and `sent_channel` records what actually carried it so nobody is left
 * wondering why no WhatsApp arrived. Once a template is approved, `templateApproved` flips and
 * WhatsApp becomes primary again without touching the cadence.
 *
 * Refusing to send anything would be the other option and it is worse: a silent step in a
 * cadence is indistinguishable from a broken cron.
 */
export function resolveChannel(input: {
  wanted: CadenceChannel;
  lastCustomerMessageAt: Date | null;
  now: Date;
  templateApproved: boolean;
  hasEmail: boolean;
  hasPhone: boolean;
}): ChannelDecision | null {
  if (input.wanted === "email") {
    if (input.hasEmail) return { channel: "email", note: null };
    /* No email but a phone: WhatsApp is inside its window only if they wrote recently. */
    if (input.hasPhone && insideWhatsAppWindow(input.lastCustomerMessageAt, input.now)) {
      return { channel: "whatsapp", note: "no email address on the lead, so this went on WhatsApp" };
    }
    return null;
  }

  // wanted === "whatsapp"
  if (input.hasPhone && (insideWhatsAppWindow(input.lastCustomerMessageAt, input.now) || input.templateApproved)) {
    return { channel: "whatsapp", note: null };
  }
  if (input.hasEmail) {
    return {
      channel: "email",
      note:
        `WhatsApp was outside Meta's ${WHATSAPP_WINDOW_HOURS}-hour customer-service window and ` +
        "no approved template is configured, so this went by email instead",
    };
  }
  return null;
}

export function insideWhatsAppWindow(lastCustomerMessageAt: Date | null, now: Date): boolean {
  if (!lastCustomerMessageAt) return false;
  const hours = (now.getTime() - lastCustomerMessageAt.getTime()) / 3_600_000;
  return hours >= 0 && hours < WHATSAPP_WINDOW_HOURS;
}

/* ── Whether a step may fire at all ──────────────────────────────────────── */

export type StepOutcome =
  | { fire: true; step: CadenceStep; channel: CadenceChannel; channelNote: string | null }
  /** Do not send this one, but DO advance the cadence. */
  | { fire: false; skip: true; reason: string }
  /** Do not send and do not advance — nothing can reach this lead. */
  | { fire: false; skip: false; reason: string };

/**
 * Decide one step.
 *
 * A missing value-drop SKIPS and advances, so an empty content slot costs the lead a touch and
 * not the rest of its cadence. An unreachable lead stops it: with neither an email address nor
 * a phone there is nothing to advance towards, and rescheduling would leave a row cycling
 * forever.
 */
export function decideStep(input: {
  step: number;
  valueDropContent: string | null | undefined;
  lastCustomerMessageAt: Date | null;
  now: Date;
  templateApproved: boolean;
  hasEmail: boolean;
  hasPhone: boolean;
}): StepOutcome {
  const step = stepAt(input.step);
  if (!step) {
    return { fire: false, skip: false, reason: `step ${input.step} is not in the cadence` };
  }

  if (step.requiresContent && !(input.valueDropContent ?? "").trim()) {
    return {
      fire: false,
      skip: true,
      reason:
        "no follow-up write-up has been saved for this workspace, so the value step was " +
        "skipped rather than written by the AI — add one in Settings and it starts going out",
    };
  }

  const channel = resolveChannel({
    wanted: step.channel,
    lastCustomerMessageAt: input.lastCustomerMessageAt,
    now: input.now,
    templateApproved: input.templateApproved,
    hasEmail: input.hasEmail,
    hasPhone: input.hasPhone,
  });

  if (!channel) {
    return {
      fire: false,
      skip: false,
      reason: "this lead has no email address and no reachable WhatsApp number",
    };
  }

  return { fire: true, step, channel: channel.channel, channelNote: channel.note };
}

/**
 * The expiry sentence for the day-7 step, built from the quote's own date.
 *
 * Never asserts "tomorrow". The window is seven days today; if that changes, an asserted
 * "tomorrow" becomes a lie nobody would think to look for. And it says the QUOTE expires, not
 * the price — the volume rate card is published and does not go away, so implying it might
 * would be manufacturing a deadline.
 */
export function expiryFact(expiresDate: string | null, now: Date): string | null {
  if (!expiresDate) return null;
  const d = new Date(`${expiresDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;

  const readable = d.toLocaleDateString("en-IN", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
  const days = Math.round((d.getTime() - now.getTime()) / 86_400_000);

  if (days < 0) return `This quote expired on ${readable}. Offer to reissue it.`;
  if (days === 0) return `This quote expires today, ${readable}.`;
  return `This quote is valid until ${readable} — ${days} day${days === 1 ? "" : "s"} from now. ` +
    "The volume rate itself is our published rate card and does not expire.";
}
