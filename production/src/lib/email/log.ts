/**
 * Writing to email_log.
 *
 * ─── WHY THIS IS CALLED FROM INSIDE sendEmail(), NOT BY CALLERS ──────────────
 * The three logs that already exist (renewal_email_log, quote_send_log,
 * compliance_reminder_log) are each written by the feature that sends. That
 * works exactly as long as whoever adds the next email path remembers, and the
 * evidence says they do not: payment confirmations and invoice mail go out today
 * with no record anywhere. Putting the write inside the send function makes
 * omission impossible rather than unlikely.
 *
 * ─── WHY IT DOES NOT BLOCK THE SEND, UNLIKE THE VAULT'S ACCESS LOG ───────────
 * The vault logs BEFORE revealing a secret and fails the reveal if the log
 * fails, because there the log IS the control — the one view somebody wants
 * hidden is exactly the one worth dropping.
 *
 * Email is the opposite shape. The record can only be written AFTER the send,
 * because the provider's id and the outcome do not exist until then. So there is
 * no log-first option, and refusing to have sent an email is not a thing you can
 * do. Throwing here would turn a bookkeeping failure into a renewal reminder
 * that never went out — strictly worse than a missing row.
 *
 * It is still not silent: a failure is reported to Sentry, because a log that
 * stops recording without telling anyone is how you end up trusting an empty
 * table.
 */
import "@/lib/sentry";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/server";
import type { EmailSendResult } from "./send";

export interface EmailLogEntry {
  tenantId: string | null;
  recipient: string;
  subject?: string | null;
  /** 'renewal_reminder', 'quote', 'invoice', … */
  kind?: string | null;
  /** Which transport this row is about. `smtp` since 11 Sep 2026. */
  provider: "resend" | "gmail" | "smtp" | "stub";
  userId?: string | null;
}

/** Narrow view of a table the generated types do not know about until 0238 runs. */
interface EmailLogTable {
  from(t: "email_log"): {
    insert(row: Record<string, unknown>): Promise<{ error: { message: string } | null }>;
  };
}

/**
 * Record one send attempt. Never throws.
 *
 * @param entry   who/what, known before the send
 * @param result  what happened, known after it
 */
export async function recordEmail(
  entry: EmailLogEntry,
  result: EmailSendResult,
): Promise<void> {
  // Without a tenant the row cannot be scoped, and an unscoped row in a
  // tenant-isolated table is worse than none — it is readable by nobody and
  // counted by everybody.
  if (!entry.tenantId) return;

  try {
    const db = createAdminClient() as unknown as EmailLogTable;
    const { error } = await db.from("email_log").insert({
      tenant_id: entry.tenantId,
      recipient: entry.recipient,
      // Subjects can carry a customer name and an amount. Truncated, not because
      // of secrecy but because an unbounded column on a per-message table is how
      // a log becomes the biggest table in the database.
      subject: entry.subject ? String(entry.subject).slice(0, 300) : null,
      kind: entry.kind ?? null,
      provider: entry.provider,
      status: result.status,
      provider_message_id: result.providerId,
      error_message: result.errorMessage ? String(result.errorMessage).slice(0, 500) : null,
      user_id: entry.userId ?? null,
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    // Reported, not thrown. See the header: the email has already gone.
    Sentry.captureException(e, { tags: { area: "email_log" } });
    console.error("[email_log] could not record send:", e);
  }
}
