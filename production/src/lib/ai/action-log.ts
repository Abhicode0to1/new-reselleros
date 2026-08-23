/**
 * The record of what the app did on its own, and why.
 *
 * ─── WHY `activity_log` WAS NOT ENOUGH ──────────────────────────────────────
 * `activity_log` already exists — tenant_id, user_id, action, entity, entity_id, label. It
 * answers "what happened". Checked on 23 Aug 2026 before writing anything new, because a
 * second log that overlaps the first is worse than no log.
 *
 * It cannot answer the question this one is for. An automated action needs three things
 * that table has no room for:
 *
 *   1. WHY — the sentence. Not a code. The operator reading this did not write the code and
 *      never will, and "quote.send failed" tells them nothing they can act on.
 *   2. THE FACTS IT RESTED ON. This is the one that matters. Today's auto-send fires
 *      because the customer STATED the billing term; if it went out wrong, the first
 *      question is "what did we think we knew" — and without the facts, the answer is a
 *      re-reading of an email that may since have been replied to.
 *   3. HELD versus DONE. A log of only what happened cannot show restraint, and restraint
 *      is most of what this system does: 13 AI routes draft, none send. An audit trail that
 *      records only sends would make a careful system look idle.
 *
 * ─── HELD IS A FIRST-CLASS OUTCOME ──────────────────────────────────────────
 * "Held" rows are the ones worth reading over breakfast: each is a real customer waiting on
 * a decision only a person can make. They are not failures and are not noise.
 */

import type { AiAction, AutonomyMode } from "./autonomy";

export type AiOutcome =
  /** Done, unattended. */
  | "did"
  /** Prepared and waiting for a person — the draft exists. */
  | "held"
  /** Deliberately not done: the mode said off, or the kill switch was on. */
  | "skipped"
  /** Tried and broke. Distinct from `skipped`, which was a choice. */
  | "failed";

export interface AiActionRecord {
  tenantId: string;
  action: AiAction;
  outcome: AiOutcome;
  /** One sentence a non-engineer can act on. */
  reason: string;
  /** The autonomy mode in force when this ran — so a later config change is explicable. */
  mode: AutonomyMode;
  /** What it was about: "lead" / "quote" / "invoice", and the id. Null for tenant-wide runs. */
  entity: string | null;
  entityId: string | null;
  /**
   * The facts the decision rested on. Small and flat on purpose — this is evidence, not a
   * request dump, and a blob nobody reads is not an audit trail.
   */
  facts: Record<string, string | number | boolean | null>;
}

export interface BuildRecordInput {
  tenantId: string;
  action: AiAction;
  outcome: AiOutcome;
  reason: string;
  mode: AutonomyMode;
  entity?: string | null;
  entityId?: string | null;
  facts?: Record<string, unknown>;
}

/** Keys whose VALUES must never reach the log. */
const REDACT = ["body", "text", "html", "message", "password", "token", "secret", "key", "apikey"];

/**
 * Builds the row, and does the two jobs that must not be left to each call site.
 *
 * FIRST, it keeps the facts small and flat. An unbounded object here becomes a
 * request dump: nobody reads it, and it quietly grows to hold whatever was in scope.
 *
 * SECOND, it keeps message bodies OUT. A customer's email body is not evidence about a
 * decision — the extracted facts are — and copying it into an audit table puts the same
 * private text in a second place with a different retention story. Redaction by KEY NAME,
 * so a call site that passes `body` gets a marker instead of a leak, rather than the log
 * silently becoming the place customer mail accumulates.
 */
export function buildAiActionRecord(input: BuildRecordInput): AiActionRecord {
  const facts: AiActionRecord["facts"] = {};
  let dropped = 0;

  for (const [k, v] of Object.entries(input.facts ?? {})) {
    const key = k.toLowerCase();
    if (REDACT.some((r) => key === r || key.endsWith(`_${r}`))) {
      facts[k] = "[redacted]";
      continue;
    }
    if (v === null || v === undefined) { facts[k] = null; continue; }
    if (typeof v === "string") {
      /* Truncated, not dropped. A long value is usually a subject line or a sentence the
         extractor matched, and the first 200 characters are what identifies it. */
      facts[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
      continue;
    }
    if (typeof v === "number" || typeof v === "boolean") { facts[k] = v; continue; }
    /* Objects and arrays are refused rather than stringified. A nested shape here is a
       request dump beginning; counting them tells the author to flatten. */
    dropped += 1;
  }

  if (dropped > 0) facts["_droppedComplexFacts"] = dropped;

  return {
    tenantId: input.tenantId,
    action:   input.action,
    outcome:  input.outcome,
    reason:   input.reason.trim(),
    mode:     input.mode,
    entity:   input.entity ?? null,
    entityId: input.entityId ?? null,
    facts,
  };
}
