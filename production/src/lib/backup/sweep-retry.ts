/**
 * Should the nightly backup sweep try again, and how many times?
 *
 * ─── THE NIGHT THIS EXISTS FOR ──────────────────────────────────────────────
 * Cloud Run, 2026-08-20T18:30:05Z (= 21 Aug 00:00 IST):
 *
 *     [cron/backup] sweep failed: JWT issued at future
 *
 * PostgREST rejected the service-role JWT as issued in the future — a clock-skew
 * rejection. One attempt, one failure, and then nothing: the Cloud Scheduler job
 * `resellersos-backup` carries a retryConfig with **no `retryCount`**, and in
 * Cloud Scheduler that means zero retries. It waits for tomorrow.
 *
 * So the whole night was lost. Measured, not assumed: `backup.snapshots` holds
 * automated rows for 2026-08-17, -18, -19, -20 and -22, and **nothing for
 * 2026-08-21**. One night in six, on a free plan with no PITR. It was found two
 * days later by reading logs, because nothing tells anyone.
 *
 * A skew that fixes itself by the next night is transient by definition, and a
 * few seconds later is a different clock reading. Hence a bounded retry.
 *
 * ─── WHY THIS IS A CLASSIFIER AND NOT `withRetry(3)` ────────────────────────
 * Retrying everything would be worse than retrying nothing. A wrong grant or an
 * unapplied migration is not going to fix itself in four seconds — retrying it
 * three times turns a clear error into the same error fifteen seconds later,
 * having tripled the load and delayed the only signal anybody gets. That is the
 * `?? "resend"` mistake in a new costume (AGENTS.md §2): a failure dressed up as
 * something survivable.
 *
 * So the rule is **default-deny**: a failure is retried only if it is on the list
 * of things a second attempt could actually fix. Anything unrecognised surfaces
 * immediately. The shape follows `lib/email/gmail-transport.ts`, which already
 * classifies its failures as `retryable` rather than blind-retrying them.
 */
import type { Database } from "@/lib/supabase/database.types";

/** Exactly what `backup_all_tenants` returns — one definition, from the DB types. */
export type SweepResult = Database["public"]["Functions"]["backup_all_tenants"]["Returns"];

/** One go at the sweep: either the RPC's payload, or the message it failed with. */
export type SweepAttempt =
  | { ok: true;  data: SweepResult }
  | { ok: false; message: string };

/**
 * Bounded, and bounded deliberately.
 *
 * The live Cloud Scheduler job gives this request an `attemptDeadline` of 540s
 * (measured 22 Aug 2026). The sweep itself takes ~2s for three tenants. Three
 * attempts with 2s + 4s of backoff is ~10s worst case — comfortably inside the
 * deadline, which matters: a retry budget that outgrew the deadline would get the
 * request cut off mid-sweep and log *nothing at all*, which is a worse failure
 * than the one being fixed.
 */
export const SWEEP_RETRY = {
  attempts: 3,
  /** One gap per retry, so `attempts - 1` entries. Never a sleep after the last try. */
  backoffMs: [2_000, 4_000],
} as const;

/**
 * Failures a later attempt could plausibly survive.
 *
 * Each entry is here because of a named mechanism, not a hunch:
 *  - the clock skew that lost 21 Aug 2026
 *  - transport blips, where the request never reached Postgres at all
 *  - Postgres contention, which is momentary by definition
 */
const RETRYABLE = [
  /* Clock skew on the JWT's `iat`. NOT the same as an expired or malformed token —
     see PERMANENT below, which is checked first. */
  "jwt issued at future",
  "jwt not yet valid",

  /* The request died in transit. Nothing ran, so nothing is half-done. */
  "fetch failed",
  "socket hang up",
  "econnreset",
  "econnrefused",
  "etimedout",
  "eai_again",
  "network error",
  "502",
  "bad gateway",
  "503",
  "service unavailable",
  "504",
  "gateway timeout",
  "upstream connect error",

  /* Two sessions collided. The next attempt has the lock to itself. */
  "deadlock detected",
  "could not serialize access",
  "too many connections",
  "connection reset by peer",
] as const;

/**
 * Failures that a retry can only delay. Checked BEFORE the retryable list,
 * because some of these also contain a retryable substring — "invalid JWT" and
 * "JWT issued at future" both mention a JWT, and only one of them is worth
 * another four seconds.
 */
const PERMANENT = [
  "jwt expired",
  "invalid jwt",
  "jwserror",
  "invalid claim",
  "permission denied",
  "does not exist",
  "violates row-level security",
  "not authorized",
  "invalid api key",

  /* Deliberately permanent. A backup sweep that runs out of statement time is
     outgrowing its window — that is a fact the owner needs to see, and retrying
     it hides the growth while tripling the load that caused it. */
  "canceling statement due to statement timeout",
] as const;

/** Is this failure worth another attempt in a few seconds? Unknown means no. */
export function isRetryableSweepError(message: string): boolean {
  const m = message.trim().toLowerCase();
  if (!m) return false;
  if (PERMANENT.some((p) => m.includes(p))) return false;
  return RETRYABLE.some((r) => m.includes(r));
}

export interface RunSweepOptions {
  /** Injected so the tests do not actually wait. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SweepRun {
  /** The last attempt's outcome — success, or the final failure. */
  result: SweepAttempt;
  attemptsMade: number;
  /** The message behind each retry, in order. Empty when nothing was retried. */
  retriedBecause: string[];
}

const realSleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

/**
 * Run the sweep, retrying only the failures on the retryable list.
 *
 * `attempt` may reject as well as resolve — supabase-js throws when the transport
 * itself dies, and an unhandled throw in a cron route produces Cloud Run's own
 * 500 with none of our log lines, which is exactly why the 12 Aug
 * /api/whatsapp/send 502 has no explanation to this day. A throw is treated as a
 * failed attempt and classified the same way.
 *
 * A PARTIAL sweep (`data.failed > 0`) is a success as far as this function is
 * concerned and is handed straight back. It must never be retried: the sweep
 * already skips past a bad tenant, and `backup._take` keeps only the newest 30
 * snapshots per tenant — so re-running it would write duplicates for the tenants
 * that already succeeded and push genuine older restore points off the shelf.
 */
export async function runSweepWithRetry(
  attempt: () => Promise<SweepAttempt>,
  opts: RunSweepOptions = {},
): Promise<SweepRun> {
  const sleep = opts.sleep ?? realSleep;
  const retriedBecause: string[] = [];
  let last: SweepAttempt = { ok: false, message: "sweep never ran" };

  for (let i = 0; i < SWEEP_RETRY.attempts; i++) {
    try {
      last = await attempt();
    } catch (err) {
      last = { ok: false, message: err instanceof Error ? err.message : String(err) };
    }

    if (last.ok) return { result: last, attemptsMade: i + 1, retriedBecause };
    if (!isRetryableSweepError(last.message)) {
      return { result: last, attemptsMade: i + 1, retriedBecause };
    }

    const isLast = i === SWEEP_RETRY.attempts - 1;
    if (isLast) break;

    retriedBecause.push(last.message);
    await sleep(SWEEP_RETRY.backoffMs[i]);
  }

  return { result: last, attemptsMade: SWEEP_RETRY.attempts, retriedBecause };
}
