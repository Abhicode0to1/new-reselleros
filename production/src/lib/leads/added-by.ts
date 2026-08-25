/**
 * "Added by" — the sentence a lead's provenance row shows.
 *
 * ─── EXTRACTED FROM JSX BECAUSE IT HAS FIVE BRANCHES ────────────────────────
 * It started as an inline IIFE inside a `<Fact>`, which meant the only way to check any branch
 * was to find a lead in that state and open its drawer. One branch got verified in a browser and
 * the other four were going to stay unverified — so it is a named function now, and the test
 * walks all five.
 *
 * ─── NULL IS AN ANSWER, NOT A BLANK ─────────────────────────────────────────
 * Measured when `leads.created_by` was added (25 Aug 2026): 15 of 29 leads arrived through the
 * inbound email webhook with no person involved and no owner either. For those, `created_by` is
 * correctly NULL and `source` is the answer — "Arrived by email" is a fact, "—" reads as missing
 * data and sends somebody looking for a bug.
 *
 * And rows that predate the column say so outright. The migration deliberately did not backfill
 * (both available inferences would have credited the wrong person), so "Not recorded — predates
 * this field" is the honest line rather than implying nobody added them.
 */
import type { UserName } from "@/lib/hooks/useUserNames";

/**
 * When `leads.created_by` started being written. Anything older cannot have it, and saying so is
 * better than showing a dash that looks like a bug.
 *
 * Matches migration `20260825230000_leads_created_by.sql`. If that timestamp ever changes, this
 * changes with it — a test asserts they are the same.
 */
export const CREATED_BY_SINCE = "2026-08-25T23:00:00Z";

export interface AddedByInput {
  createdBy: string | null | undefined;
  source: string | null | undefined;
  /** ISO timestamp from `leads.created_at`. */
  createdAt: string | null | undefined;
}

/**
 * Who added this lead, in words.
 *
 * @param names id → name, from `useUserNames`. Undefined while it loads.
 */
export function addedByLabel(
  lead: AddedByInput,
  names?: Map<string, UserName>,
): string {
  if (lead.createdBy) {
    const u = names?.get(lead.createdBy);
    /* No entry means the row points at a user this tenant can no longer see — almost always
       somebody who left. Naming that is more useful than a uuid or a dash, and it is the truth:
       a colleague did add this lead. */
    if (!u) return "a colleague who has left";
    return u.inactive ? `${u.label} (no longer active)` : u.label;
  }

  /* No person added it. `source` says what did — and each of these is a real value from the live
     table, not a guess at what might appear. */
  switch (lead.source) {
    case "email-inbound":
      return "Arrived by email — nobody added it";
    case "whatsapp":
      return "Arrived on WhatsApp — nobody added it";
    case "tele-calling":
      return "Created by the calling agent";
    case "csv":
      return "Imported from a file";
    default:
      break;
  }

  /* Older than the column. Distinguished from "we do not know" because the reason is knowable
     and acting on it is different: nothing is broken, the field simply did not exist yet. */
  if (lead.createdAt && new Date(lead.createdAt) < new Date(CREATED_BY_SINCE)) {
    return "Not recorded — predates this field";
  }

  return "—";
}
