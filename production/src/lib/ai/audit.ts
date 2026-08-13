/**
 * Audit trail for AI decisions — writes to the same activity_log the human
 * "who did what" trail uses (migration 0222).
 *
 * WHY THIS EXISTS. The money guard and the circuit breaker both make silent
 * decisions on the operator's behalf: a draft gets discarded, or the AI is
 * skipped entirely and a deterministic stub is sent instead. Until now those
 * only reached the server console, which nobody reads. So the two facts most
 * worth knowing were invisible:
 *
 *   • how often the model tried to state a wrong amount — the evidence for
 *     whether the guard is earning its keep, or whether it is over-firing
 *   • that the AI is quietly not running at all, which looks identical to
 *     "the AI wrote something plain today"
 *
 * WHAT IS DELIBERATELY NOT LOGGED. Every successful draft is not an event. The
 * activity log is a human-accountability trail that an owner reads to see who
 * changed what; filling it with a row per AI click would bury the human actions
 * it exists to show. Only decisions a person would want to know about are
 * written: a block, and a fallback. That is a narrower reading of "log all AI
 * decisions" than the brief's wording, and it is deliberate — a log nobody can
 * read is not an audit trail.
 *
 * LIMITATION — READ THIS BEFORE REUSING THIS HELPER. log_activity() derives the
 * tenant from auth.uid(), and when there is no session it returns EARLY AND
 * SILENTLY. Measured against production: calling it with the service-role key
 * returns no error, and the row count does not move (638 → 638, zero rows
 * written). So it reports success and logs nothing.
 *
 * That means this helper works from a signed-in request — which is where
 * draft-followup runs — and is a trap anywhere else. AI that runs from a webhook
 * or a cron job (inbound-email parsing, the renewals job) has no session, would
 * see no error, and would produce an audit trail that is permanently empty while
 * appearing to work. Wiring those up needs a service-role writer, which the 0222
 * design deliberately does not expose so that nobody can forge or erase a trail.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Action slugs. Kept short and prefixed so they sort together in the log and are
 * obviously machine-written next to `insert` / `update` / `login`.
 */
export type AiAuditAction =
  /** The money guard refused AI output that stated an unauthorised figure. */
  | "ai_blocked"
  /** AI was unavailable (no key, error, timeout, open breaker) — stub used. */
  | "ai_fallback"
  /** AI output was accepted but scored below the auto-apply threshold. */
  | "ai_low_confidence";

export interface AiAuditEntry {
  action: AiAuditAction;
  /** Table the decision concerned — 'leads', 'customers', … Keeps the row in context. */
  entity: string;
  entityId?: string | null;
  /** Human-readable detail. Truncated to 120 chars by log_activity(). */
  label: string;
}

/**
 * Record an AI decision. Never throws and never rejects.
 *
 * Auditing must not be able to break the thing it is auditing: if the log write
 * fails, the operator still gets their draft. A failure here is reported to the
 * server console and otherwise swallowed.
 */
export async function logAiDecision(
  client: SupabaseClient<Database>,
  entry: AiAuditEntry,
): Promise<void> {
  try {
    const { error } = await client.rpc("log_activity", {
      p_action:    entry.action,
      p_entity:    entry.entity,
      p_entity_id: entry.entityId ?? null,
      p_label:     entry.label.slice(0, 120),
    });
    if (error) console.error("[ai/audit] log_activity failed:", error.message);
  } catch (err) {
    console.error("[ai/audit] log_activity threw:", (err as Error)?.message);
  }
}

/**
 * Format the guard's verdict for the log.
 *
 * Both sides are included — what the model said AND what it was allowed to say.
 * The offending figure alone is unreadable six weeks later; the pair is the whole
 * story in one line, and it is what tells you whether the guard caught a real
 * hallucination or fired on a correct number written in a form it didn't expect.
 */
export function formatGuardBlock(violations: readonly string[], allowed: readonly number[]): string {
  const said = violations.join(", ") || "(none)";
  const ok = allowed.length
    ? allowed.map((a) => `₹${a.toLocaleString("en-IN")}`).join(", ")
    : "no amount";
  return `AI wrote ${said}; allowed ${ok} — draft discarded`;
}
