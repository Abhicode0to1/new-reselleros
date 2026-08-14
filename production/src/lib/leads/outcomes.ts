/**
 * The 1-tap call-outcome chips: what each one actually changes.
 *
 * A rep working a call list needs one tap per lead, not a menu. But "one tap" is
 * exactly where a CRM starts lying: the fastest way to make a pipeline look busy is a
 * button that advances a stage without the thing it claims having happened. So the
 * rule for every chip in here is that it records what the rep DID, never what we hope
 * it means.
 *
 * ─── THE ONE THAT DELIBERATELY DOES NOT MOVE THE STAGE ──────────────────────
 * "Send Quote" navigates to the quote builder. It does NOT set stage = "quote".
 *
 * That is not laziness, it is the difference between a pipeline and a wish list.
 * `stage = "quote"` is load-bearing in three places: intentTier() in heat.ts calls it
 * an advanced stage, heatScore() scores it 1.00 for funnel progress, and the Deals
 * pipeline counts it as qualified. A chip that set it on tap would let a rep create a
 * screenful of hot, quote-stage leads without a single quote existing — and the
 * forecast built on them would be fiction. The stage moves when a quote row is
 * actually created, which the quote builder already does.
 *
 * ─── "NO ANSWER" IS NOT "CONTACTED" ────────────────────────────────────────
 * Same rule. An unanswered call is an ATTEMPT: it is logged, and the lead comes back
 * tomorrow. Moving it to `contact` would mean the funnel counted ringing a phone as
 * reaching a human, and every "we contacted 40 leads this week" number after that
 * would be wrong.
 *
 * ─── DATES ARE COMPUTED IN LOCAL TIME, ON PURPOSE ──────────────────────────
 * `follow_up_date` is a DATE column, and the users are in IST (UTC+5:30).
 * `new Date().toISOString().slice(0,10)` returns YESTERDAY's date for any moment
 * before 05:30 IST, so a rep tapping "Call tomorrow" at 7am would sometimes book the
 * call for today and sometimes for yesterday. This module formats from local date
 * parts instead. (The same `toISOString().split("T")[0]` pattern appears elsewhere in
 * this codebase — worth a sweep, but not silently changed from here.)
 */
import type { Lead } from "@/lib/supabase/database.types";

export type LeadOutcome = "no_answer" | "call_tomorrow" | "send_quote" | "mark_junk";

/** YYYY-MM-DD from LOCAL date parts — never via toISOString(). See the header. */
export function localDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Tomorrow, in local time, as YYYY-MM-DD. Month and year roll over correctly. */
export function tomorrowISO(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return localDateISO(d);
}

export interface OutcomeEffect {
  /** Columns to write on the lead. Null when the chip writes nothing. */
  patch: Partial<Pick<Lead, "follow_up_date" | "is_junk">> | null;
  /** An activity row to log, so the attempt is on the record. */
  activity: { kind: string; detail: string } | null;
  /** The chip opens a screen instead of (or as well as) writing. */
  navigate: "quote" | null;
  /** Confirmation text. Says what happened, including the new date. */
  toast: string;
  /** True when the rep can put it back — drives whether an Undo action is offered. */
  undoable: boolean;
  /** Stage is never touched by a chip. Present so the intent is explicit, not implied. */
  readonly stageChange: null;
}

/**
 * What a chip does to a lead.
 *
 * Pure: no mutation, no navigation, no toast. The caller performs the effect. That
 * keeps the RULES testable without a Supabase mock or a router, which is why the
 * previous scattered quick-actions had none.
 */
export function applyOutcome(
  outcome: LeadOutcome,
  lead: Pick<Lead, "company" | "contact_phone" | "follow_up_date">,
  now: Date = new Date(),
): OutcomeEffect {
  const tomorrow = tomorrowISO(now);
  const who = lead.company || "this lead";

  switch (outcome) {
    case "no_answer":
      /* Logged as an attempt and pushed to tomorrow. The stage stays put — see the
         header. The phone number goes in the detail so the log is useful later even
         if the number is edited. */
      return {
        patch: { follow_up_date: tomorrow },
        activity: {
          kind: "call",
          detail: `No answer${lead.contact_phone ? ` · ${lead.contact_phone}` : ""} — retrying tomorrow`,
        },
        navigate: null,
        toast: `No answer logged · ${who} comes back tomorrow`,
        undoable: true,
        stageChange: null,
      };

    case "call_tomorrow":
      /* Always tomorrow, even when a later date is already set. The rep just said
         "tomorrow"; quietly keeping next Friday because it was further out would
         override the person holding the phone. */
      return {
        patch: { follow_up_date: tomorrow },
        activity: { kind: "note", detail: "Follow-up moved to tomorrow" },
        navigate: null,
        toast: `${who} scheduled for tomorrow`,
        undoable: true,
        stageChange: null,
      };

    case "send_quote":
      /* Navigation only. NOT stage = "quote" — the stage moves when a quote row
         exists. See the header for why this matters more than it looks. */
      return {
        patch: null,
        activity: null,
        navigate: "quote",
        toast: "",
        undoable: false,
        stageChange: null,
      };

    case "mark_junk":
      return {
        patch: { is_junk: true },
        activity: { kind: "note", detail: "Marked junk from the call queue" },
        navigate: null,
        toast: `${who} marked junk`,
        undoable: true,
        stageChange: null,
      };
  }
}

/** Chip presentation, so the row, the card and the swipe sheet render one vocabulary. */
export const OUTCOME_CHIPS: ReadonlyArray<{
  id: LeadOutcome;
  label: string;
  icon: string;
  tone: "default" | "amber" | "rose";
  /** Why this chip exists, for the title attribute — no mystery buttons. */
  hint: string;
  /** True when the chip needs a phone number to make sense. */
  needsPhone: boolean;
}> = [
  { id: "no_answer",     label: "No answer",    icon: "mobile", tone: "default",
    hint: "Log the attempt and bring this lead back tomorrow. Stage is not changed — ringing a phone is not contact.",
    needsPhone: true },
  { id: "call_tomorrow", label: "Call tomorrow", icon: "clock",  tone: "amber",
    hint: "Move the follow-up date to tomorrow.", needsPhone: false },
  { id: "send_quote",    label: "Send quote",   icon: "send",   tone: "amber",
    hint: "Open the quote builder with this lead's details. The stage moves when the quote is actually created.",
    needsPhone: false },
  { id: "mark_junk",     label: "Junk",         icon: "alert",  tone: "rose",
    hint: "Hide as spam or a fake enquiry. Restorable from the Junk view.", needsPhone: false },
];
