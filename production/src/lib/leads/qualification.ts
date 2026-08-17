/**
 * The two gates of the funnel: what makes a lead JUNK, and what makes it QUALIFIED.
 *
 *   Junk  ←  Raw Lead  →  Qualified Deal
 *
 * ─── WHY JUNK NEEDS A REASON AND A BOOLEAN IS NOT ENOUGH ────────────────────
 * `leads.is_junk` records that somebody binned a lead and nothing about why. That is
 * fine until the day it is wrong — and it will be, because junk is judged in a hurry.
 * A lead binned as "fake number" can be recovered the moment a real number arrives; a
 * lead binned as "student enquiry" cannot. Without the reason both look identical, so
 * nobody dares un-bin either, and real enquiries stay dead.
 *
 * It also makes the marketing question answerable: "how much of this source is spam"
 * is a different problem from "how much of it is unresponsive".
 *
 * ─── AND WHY QUALIFICATION IS DERIVED, NOT TICKED ───────────────────────────
 * The brief asks for three verification checkboxes. Checkboxes would be a fourth
 * source of truth about facts the app ALREADY stores — and a checkbox that disagrees
 * with the data underneath it is worse than no checkbox, because it is the one a rep
 * believes.
 *
 * So each check reads the row: a phone that looks like a phone, a plan that was
 * chosen, a seat count and a date. Nobody can tick "verified" on a lead with no
 * number, and nobody has to re-tick anything when the number is fixed.
 */
import type { Lead } from "@/lib/supabase/database.types";

/* ── Junk ──────────────────────────────────────────────────────────────────── */

export type JunkReasonId =
  | "fake_phone" | "spam_email" | "not_commercial" | "unresponsive" | "other";

export interface JunkReason {
  id: JunkReasonId;
  label: string;
  /** Shown under the label — what this choice means for the lead's future. */
  consequence: string;
  /** True when a real enquiry could still be hiding behind it. */
  recoverable: boolean;
  /**
   * Does this count against the source's spam rate?
   *
   * A field rather than something inferred from the wording. A student asking a real
   * question is a real human and a poor fit; a bounced submission is a bot. Both are
   * junk and only one is spam, and a marketing decision made on a number that mixed
   * them would cut a channel that is working.
   */
  countsAsSpam: boolean;
}

/**
 * The reasons, ordered by how often a rep reaches for them.
 *
 * `recoverable` is the field that earns its keep. Three of these describe something
 * about the CONTACT DETAILS, which can change — a fake number today can be a real one
 * tomorrow, and the lead is worth keeping findable. "Not commercial" describes the
 * PERSON, which will not change. Presenting both as the same kind of dead end is how a
 * recoverable enquiry gets treated as permanently gone.
 */
export const JUNK_REASONS: readonly JunkReason[] = [
  {
    id: "fake_phone", label: "Invalid or fake phone number",
    consequence: "Kept findable — if a real number arrives this can be un-junked.",
    recoverable: true,
    countsAsSpam: false,
  },
  {
    id: "spam_email", label: "Bounced email or spam submission",
    consequence: "Filed as spam. Counts against this source in reporting.",
    recoverable: false,
    countsAsSpam: true,
  },
  {
    id: "not_commercial", label: "Not a business enquiry (student, job seeker)",
    consequence: "Genuine person, nothing to sell them. Not counted as spam.",
    recoverable: false,
    countsAsSpam: false,
  },
  {
    id: "unresponsive", label: "No reply after 5 or more attempts",
    consequence: "Kept findable — they may come back, and the history is worth having.",
    recoverable: true,
    countsAsSpam: false,
  },
  {
    id: "other", label: "Something else",
    consequence: "Say what it was, so the next person reading this knows.",
    recoverable: true,
    countsAsSpam: false,
  },
] as const;

export function junkReason(id: JunkReasonId): JunkReason {
  const r = JUNK_REASONS.find((x) => x.id === id);
  /* Throws rather than defaulting. A junk record whose reason silently became
     "other" is exactly the unexplained bin this module exists to prevent. */
  if (!r) throw new Error(`Unknown junk reason: ${id}`);
  return r;
}

/** "Something else" has to say what else — a free-text reason of "" explains nothing. */
export function junkNoteRequired(id: JunkReasonId): boolean {
  return id === "other";
}

export interface JunkSubmission {
  reasonId: JunkReasonId;
  note: string;
}

export type JunkValidation =
  | { ok: true }
  | { ok: false; error: string };

export function validateJunk(input: JunkSubmission): JunkValidation {
  if (!JUNK_REASONS.some((r) => r.id === input.reasonId)) {
    return { ok: false, error: "Pick a reason before marking this as junk." };
  }
  if (junkNoteRequired(input.reasonId) && input.note.trim().length < 3) {
    return { ok: false, error: "Say what the reason was — “Something else” needs a note." };
  }
  return { ok: true };
}

/* ── Qualification ─────────────────────────────────────────────────────────── */

export interface QualificationCheck {
  id: "contactable" | "product" | "commitment";
  label: string;
  passed: boolean;
  /** What is missing, in words a rep can act on. Null when passed. */
  missing: string | null;
}

/** A phone that could actually be dialled: 10 digits starting 6-9, ISD prefixes ok. */
function looksDialable(phone: string | null | undefined): boolean {
  const d = (phone ?? "").replace(/\D/g, "");
  const local = d.replace(/^(?:0091|91|0)(?=[6-9]\d{9}$)/, "");
  return /^[6-9]\d{9}$/.test(local);
}

function looksLikeEmail(email: string | null | undefined): boolean {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test((email ?? "").trim());
}

export type QualifiableLead = Pick<
  Lead, "contact_phone" | "contact_email" | "plan" | "seats" | "expected_close_date"
>;

/**
 * The three gates between a raw lead and a quotable deal.
 *
 * Read from the row every time. Nothing is stored, so nothing can go stale, and a
 * lead that gains a phone number becomes contactable without anyone revisiting it.
 */
export function qualificationChecks(l: QualifiableLead): QualificationCheck[] {
  const phoneOk = looksDialable(l.contact_phone);
  const emailOk = looksLikeEmail(l.contact_email);
  /* BOTH, not either. A quote goes out by email and gets chased by phone — one
     without the other stalls the deal at exactly the wrong moment. */
  const contactable = phoneOk && emailOk;

  const seats = l.seats ?? 0;
  const hasDate = Boolean(l.expected_close_date);

  return [
    {
      id: "contactable",
      label: "Phone and email both usable",
      passed: contactable,
      missing: contactable ? null
        : !phoneOk && !emailOk ? "No usable phone or email yet."
        : !phoneOk ? "Email is fine; the phone number cannot be dialled."
        : "Phone is fine; the email address is not valid.",
    },
    {
      id: "product",
      label: "Knows which product they want",
      passed: Boolean(l.plan?.trim()),
      missing: l.plan?.trim() ? null : "No plan chosen — ask which licence they need.",
    },
    {
      id: "commitment",
      label: "Seat count and a decision date",
      passed: seats > 0 && hasDate,
      missing: seats > 0 && hasDate ? null
        : seats <= 0 && !hasDate ? "No seat count and no expected close date."
        : seats <= 0 ? "Decision date is set, but nobody has said how many seats."
        : `${seats} seats agreed, but no expected close date.`,
    },
  ];
}

export interface QualificationVerdict {
  checks: QualificationCheck[];
  passedCount: number;
  /** All three met. */
  qualified: boolean;
  /** One line for the drawer when it is not. */
  blocker: string | null;
}

export function qualification(l: QualifiableLead): QualificationVerdict {
  const checks = qualificationChecks(l);
  const failed = checks.filter((c) => !c.passed);
  return {
    checks,
    passedCount: checks.length - failed.length,
    qualified: failed.length === 0,
    /* The FIRST unmet gate, not a list. A rep chasing three things at once chases
       none of them; the next phone call has one purpose. */
    blocker: failed[0]?.missing ?? null,
  };
}
