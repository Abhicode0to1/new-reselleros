/**
 * The AI telecaller's decisions, with no I/O in them.
 *
 * Two questions live here and nothing else does:
 *   1. MAY we ring this number, right now?      → decideTelecall
 *   2. What did that call actually amount to?   → classifyCall
 *
 * Pure, because both are the parts worth testing and neither needs a database to answer. The
 * dialling, the row and the quote live in telecall.server.ts, actions/telecall-dispatcher.ts
 * and the two routes.
 *
 * ─── A CALL IS NOT A LOUDER EMAIL ───────────────────────────────────────────
 * Every guard in this file exists because voice differs from text in ways that matter:
 *
 *   · IT CANNOT BE UNSAID. A wrong price in an email is followed by a correction the
 *     customer reads next to the original. A wrong price spoken down a phone line is what
 *     they repeat back to us in a fortnight. So the money check here runs on the transcript
 *     AFTER the call and its only power is to fetch a human immediately — see verifyCallMoney,
 *     which is careful about what it can and cannot claim.
 *   · IT INTERRUPTS. An email at 21:30 waits in an inbox. A phone call at 21:30 is somebody's
 *     evening. This module does not invent a calling window for that — it reuses
 *     `quietHoursDecision`, which the rest of the app already obeys, so there is one answer to
 *     "when may this business contact a customer" rather than a second one that drifts.
 *   · IT IS REGULATED. Unsolicited commercial calls in India are the CALLER's problem, not the
 *     telephony vendor's. `doNotCall` is therefore a refusal with its own sentence, not a
 *     filter applied somewhere upstream and hoped for.
 */
import { quietHoursDecision } from "@/lib/mastery/quiet-hours";
import { verifyDraftMoney } from "./money-guard";
import type { SalesCatalogEntry } from "./sales-agent";

/* ── Vocabulary. Mirrors the CHECK constraints in
      supabase/migrations/20260825120000_ai_telecalling.sql — the database is the authority and
      these types exist so a typo is a compile error rather than a 23514 at 3am. ───────────── */

export type TelecallType = "lead_qualification" | "renewal_reminder";

export type TelecallStatus =
  | "held"
  | "queued"
  | "completed"
  | "no_answer"
  | "busy"
  | "failed"
  | "refused";

export type TelecallAction =
  | "none"
  | "quote_requested"
  | "callback_requested"
  | "renewal_confirmed"
  | "not_interested"
  | "handed_to_human";

/**
 * Do not ring the same number twice inside a day.
 *
 * Not a rate limit — a politeness floor. The renewal cron runs daily and reads a five-day
 * window, so without this the same customer is rung on each of the five days before their
 * renewal. Five calls in five days from an automated voice is how a business gets its number
 * blocked, and the fifth call is not more persuasive than the first.
 */
export const MIN_HOURS_BETWEEN_CALLS = 24;

/**
 * Three attempts, then it is a person's job.
 *
 * "No answer" three times is information: this customer does not take calls from unknown
 * numbers. A fourth automated attempt adds nothing and the app should say so out loud rather
 * than keep dialling into silence.
 */
export const MAX_CALL_ATTEMPTS = 3;

/* ── The number ──────────────────────────────────────────────────────────── */

/**
 * A typed Indian phone number → E.164, or null if it is not one.
 *
 * Null rather than a best guess, and that is the whole point of the function. The cost of the
 * two outcomes is not symmetric: refusing to ring a valid number wastes one lead, and ringing
 * a WRONG number plays a sales pitch at a stranger who never contacted us. Digits are stripped
 * of the shapes people actually type — "+91 98765 43210", "098765-43210", "0091..." — and
 * anything left that is not a plausible mobile or landline is refused.
 *
 * A bare 10-digit number is assumed +91. That assumption is stated rather than hidden because
 * it IS an assumption: this deployment sells to Indian businesses, and `leads.contact_phone`
 * is free text a rep typed. An international number must arrive with its own `+`.
 */
export function normaliseIndianPhone(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;

  /* An extension makes the number un-diallable by an automated agent — it would ring the
     switchboard and read a script to a receptionist. Refuse rather than dial the trunk. */
  if (/\b(ext|extn|x)\.?\s*\d+/i.test(trimmed)) return null;

  const hadPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  if (hadPlus) {
    /* Already international. E.164 allows 8–15 digits; anything outside that is a typo, and a
       typo dialled is somebody else's phone. */
    if (digits.length < 8 || digits.length > 15) return null;
    if (digits.startsWith("0")) return null;
    return `+${digits}`;
  }

  // 00 91 98765 43210 — the other way people write an international prefix.
  const withoutIdd = digits.startsWith("00") ? digits.slice(2) : digits;

  // 91 98765 43210
  if (withoutIdd.length === 12 && withoutIdd.startsWith("91")) {
    return normaliseIndianPhone(`+${withoutIdd}`);
  }

  // 0 98765 43210 — the domestic trunk prefix, which must not survive into E.164.
  const local = withoutIdd.startsWith("0") ? withoutIdd.slice(1) : withoutIdd;

  /* Ten digits, and the first must be 6–9. Indian mobile series start there; a 10-digit
     string beginning 0–5 is a landline typed without its STD code, which cannot be dialled
     from outside its own city and would connect to the wrong subscriber elsewhere. */
  if (local.length === 10 && /^[6-9]/.test(local)) return `+91${local}`;

  return null;
}

/** True when two numbers are the same subscriber, comparing normalised forms. */
function sameNumber(a: string, b: string | null | undefined): boolean {
  const other = normaliseIndianPhone(b);
  return other !== null && other === a;
}

/* ── May we ring? ────────────────────────────────────────────────────────── */

export interface TelecallRequest {
  callType: TelecallType;
  /** As recorded on the lead or the customer — free text, not yet trusted. */
  rawPhone: string | null;
  /** The instant being judged. Passed in so this stays testable at 21:01 on a Saturday. */
  at: Date;
  /** The most recent call to this number, or null if we never have. */
  lastCalledAt: Date | null;
  /** How many times we have already tried this subject. */
  attemptsSoFar: number;
  /** Our own numbers. Ringing ourselves is the voice version of the self-email loop. */
  ourNumbers: readonly string[];
  /** The customer asked not to be called. */
  doNotCall: boolean;
  /**
   * Is the thing this call is about still open — a live lead, an active subscription?
   * `false` must arrive WITH a reason, because "we did not ring them" and "we did not ring
   * them because they cancelled in March" are different rows to an operator.
   */
  subjectIsOpen: boolean;
  subjectClosedReason: string | null;
}

export interface TelecallDecision {
  place: boolean;
  /** The normalised number. Present even on a refusal, whenever it parsed at all. */
  phone: string | null;
  /** One sentence a non-engineer can act on. Always present, including when placing. */
  reason: string;
  /**
   * When this would become placeable, for refusals that are about TIMING rather than about
   * the customer. Null when waiting changes nothing.
   */
  retryAfter: Date | null;
}

/**
 * Decide whether to place this call.
 *
 * Ordered most-permanent refusal first, so the reason an operator reads is the one that
 * actually needs dealing with: "they asked us not to call" outranks "it is 9pm", because
 * fixing the clock does not fix the first.
 */
export function decideTelecall(input: TelecallRequest): TelecallDecision {
  const phone = normaliseIndianPhone(input.rawPhone);

  if (input.doNotCall) {
    return {
      place: false,
      phone,
      reason: "this customer has asked not to be called — nothing automated may ring them",
      retryAfter: null,
    };
  }

  if (!phone) {
    return {
      place: false,
      phone: null,
      reason: input.rawPhone?.trim()
        ? `"${input.rawPhone.trim()}" is not a number this app can dial — add a 10-digit mobile or a full +country number`
        : "no phone number is recorded for this customer",
      retryAfter: null,
    };
  }

  if (input.ourNumbers.some((n) => sameNumber(phone, n))) {
    return {
      place: false,
      phone,
      reason: "that is one of our own numbers — nothing is dialled back to ourselves",
      retryAfter: null,
    };
  }

  if (!input.subjectIsOpen) {
    return {
      place: false,
      phone,
      reason:
        input.subjectClosedReason?.trim() ||
        "the lead or subscription this call is about is no longer open",
      retryAfter: null,
    };
  }

  if (input.attemptsSoFar >= MAX_CALL_ATTEMPTS) {
    return {
      place: false,
      phone,
      reason:
        `already tried ${input.attemptsSoFar} times — this customer does not take automated ` +
        "calls, so it is worth a person or a different channel",
      retryAfter: null,
    };
  }

  if (input.lastCalledAt) {
    const hours = (input.at.getTime() - input.lastCalledAt.getTime()) / 3_600_000;
    if (hours < MIN_HOURS_BETWEEN_CALLS) {
      const retryAfter = new Date(
        input.lastCalledAt.getTime() + MIN_HOURS_BETWEEN_CALLS * 3_600_000,
      );
      return {
        place: false,
        phone,
        reason:
          `we rang this number ${Math.max(0, Math.floor(hours))} hours ago — the next automated ` +
          `call is not before ${MIN_HOURS_BETWEEN_CALLS} hours have passed`,
        retryAfter,
      };
    }
  }

  /* Quiet hours, reused rather than reinvented — see the header. `reminder` is the class both
     of these calls belong to: they are the stressful, business-hours kind, and neither is a
     receipt somebody is refreshing their phone for. The exemption list in quiet-hours.ts
     (transactional, security) deliberately has no voice member. */
  const quiet = quietHoursDecision("reminder", input.at);
  if (!quiet.send) {
    return {
      place: false,
      phone,
      reason: `not calling now — ${quiet.explanation.toLowerCase().replace(/\.$/, "")}`,
      retryAfter: quiet.sendAfter,
    };
  }

  return { place: true, phone, reason: "inside calling hours, and nothing blocks this call", retryAfter: null };
}

/* ── What the call amounted to ───────────────────────────────────────────── */

/**
 * The provider's post-call payload, already normalised by the webhook route.
 *
 * Booleans rather than the provider's own strings, because Retell and Vapi disagree about
 * every label and the shape of this module must not follow whichever one is wired this month.
 */
export interface PostCallSignals {
  /** The provider's own disposition word — mapped, not trusted, by statusFromDisposition. */
  disposition: string;
  durationSec: number | null;
  transcript: string;
  summary: string;
  customerAskedForQuote: boolean;
  customerAskedForCallback: boolean;
  customerConfirmedRenewal: boolean;
  customerNotInterested: boolean;
  /** Seats the customer stated. Null when they did not. */
  seatsDiscussed: number | null;
}

/**
 * Provider disposition → our status.
 *
 * Unknown maps to `failed`, not `completed`. A word we do not recognise means the provider
 * changed its vocabulary, and treating that as success would file a call that may never have
 * connected as a conversation that happened.
 */
export function statusFromDisposition(disposition: string): TelecallStatus {
  const d = disposition.trim().toLowerCase();

  if (["completed", "ended", "call_ended", "hangup", "customer-ended-call", "agent-ended-call"].includes(d)) {
    return "completed";
  }
  if (["no_answer", "no-answer", "noanswer", "no_response", "customer-did-not-answer", "voicemail"].includes(d)) {
    return "no_answer";
  }
  if (["busy", "user_busy", "customer-busy"].includes(d)) return "busy";
  return "failed";
}

/**
 * A call that connected but said nothing.
 *
 * Under this, a "completed" call is a wrong number hanging up or a voicemail beep — not a
 * conversation. Deciding a quote off six seconds of audio is how an automated system emails a
 * price to somebody who never spoke to it.
 */
export const MIN_MEANINGFUL_CALL_SEC = 20;

export interface CallClassification {
  status: TelecallStatus;
  action: TelecallAction;
  /** Set when a person must pick this up, with the sentence they should read. */
  handoverReason: string | null;
  /** One line for the lead's timeline. */
  detail: string;
}

/**
 * What happened, and what should happen next.
 *
 * Order matters and is the argument: "not interested" is checked BEFORE "asked for a quote",
 * because a customer who says both said no last. Quoting somebody who declined is the single
 * most damaging thing this feature could do unattended.
 */
export function classifyCall(signals: PostCallSignals, callType: TelecallType): CallClassification {
  const status = statusFromDisposition(signals.disposition);

  if (status !== "completed") {
    return {
      status,
      action: "none",
      handoverReason: null,
      detail: `AI call ${status.replace("_", " ")} — nothing was discussed.`,
    };
  }

  const duration = signals.durationSec ?? 0;
  if (duration < MIN_MEANINGFUL_CALL_SEC) {
    return {
      status,
      action: "none",
      handoverReason: null,
      detail:
        `AI call connected for ${duration}s — too short to have been a conversation, so nothing ` +
        "was concluded from it.",
    };
  }

  if (signals.customerNotInterested) {
    return {
      status,
      action: "not_interested",
      handoverReason: null,
      detail: "AI call — the customer said they are not interested. Nothing further was sent.",
    };
  }

  if (signals.customerConfirmedRenewal && callType === "renewal_reminder") {
    return {
      status,
      action: "renewal_confirmed",
      handoverReason: null,
      detail: "AI call — the customer confirmed they intend to renew.",
    };
  }

  if (signals.customerAskedForQuote) {
    if (signals.seatsDiscussed === null || signals.seatsDiscussed <= 0) {
      /* A quote needs a seat count, and the call is over — so there is no way to ask. This is
         a handover rather than a guess: the app has a phone number and a person can ring back
         in thirty seconds, which is cheaper than a quote for the wrong number of seats. */
      return {
        status,
        action: "handed_to_human",
        handoverReason:
          "the customer asked for a quotation on the call but never said how many seats — " +
          "ring them back for the number, then send it",
        detail: "AI call — quotation requested, but the seat count was never stated.",
      };
    }
    return {
      status,
      action: "quote_requested",
      handoverReason: null,
      detail: `AI call — the customer asked for a quotation for ${signals.seatsDiscussed} seats.`,
    };
  }

  if (signals.customerAskedForCallback) {
    return {
      status,
      action: "callback_requested",
      handoverReason: "the customer asked to be called back by a person",
      detail: "AI call — the customer asked for a callback from a person.",
    };
  }

  return {
    status,
    action: "none",
    handoverReason: null,
    detail: `AI call completed (${duration}s) — no action was asked for.`,
  };
}

/* ── Money that was spoken out loud ──────────────────────────────────────── */

/**
 * Every rupee figure the agent was authorised to say on this call.
 *
 * The catalogue's per-seat-per-YEAR rates, plus whatever the app itself computed and handed
 * over as a fact (an outstanding renewal amount). Deliberately NOT seats × price: the agent is
 * not given arithmetic, for the same reason `authorisedTotalsFor` exists on the email side —
 * a model that multiplies is a model that can multiply wrongly, out loud, irreversibly.
 */
export function authorisedCallFigures(
  catalogue: readonly SalesCatalogEntry[],
  appComputed: readonly number[] = [],
): number[] {
  const out = new Set<number>();
  for (const c of catalogue) out.add(Math.round(c.msrpPerSeatPerYear));
  for (const n of appComputed) if (Number.isFinite(n)) out.add(Math.round(n));
  return [...out];
}

export interface CallMoneyVerdict {
  ok: boolean;
  /** The figures spoken that were not on the authorised list. */
  violations: string[];
  /** A handover sentence, or null when nothing was said out of turn. */
  handoverReason: string | null;
}

/**
 * Did the agent quote a number nobody authorised?
 *
 * ─── WHAT THIS CAN AND CANNOT DO, STATED PLAINLY ────────────────────────────
 * It runs on a transcript, AFTER the call. It cannot stop the sentence — the customer has
 * already heard it. Its entire value is that a person finds out in seconds instead of when
 * the customer quotes it back, and it is written down that way rather than dressed up as a
 * guard, because a guard that cannot refuse is a detector.
 *
 * It also has a real blind spot: speech-to-text may render "ten thousand three hundred and
 * sixty-eight rupees" as words, and `verifyDraftMoney` matches DIGITS. So a clean pass here is
 * weaker evidence than a clean pass on an email draft. `bareNumberFloor` is set low precisely
 * because of that — on a sales call almost any four-figure bare number is money, and a false
 * flag costs one glance at a transcript while a miss costs a wrong price already spoken.
 */
export function verifyCallMoney(
  transcript: string,
  authorised: readonly number[],
): CallMoneyVerdict {
  const verdict = verifyDraftMoney(transcript, authorised, { bareNumberFloor: 1000 });
  if (verdict.ok) return { ok: true, violations: [], handoverReason: null };

  return {
    ok: false,
    violations: verdict.violations,
    handoverReason:
      `the agent said ${verdict.violations.join(", ")} on the call, and that figure is not on ` +
      "the catalogue — listen to the recording and correct it with the customer before anything " +
      "is sent in writing",
  };
}
