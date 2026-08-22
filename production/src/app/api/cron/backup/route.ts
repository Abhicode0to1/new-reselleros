/**
 * Nightly backup cron — one restore point per tenant, every night.
 *
 * Schedule: 00:00 IST via CLOUD SCHEDULER (scripts/setup-cloud-scheduler.sh).
 * NOT vercel.json — the live deployment is Cloud Run, where Vercel crons do not
 * exist and that file is inert. Registering it there would produce a job that
 * looks scheduled in the repo and never runs, which for a backup is the worst
 * possible failure: you find out it was never running on the day you need it.
 *
 * ─── WHY THIS ROUTE EXISTS AT ALL ───────────────────────────────────────────
 * The in-app backup was owner-triggered, plus `auto_backup_if_stale()` (0212)
 * which fires only when somebody OPENS Settings → Backup. So a tenant whose owner
 * does not visit that page had no automatic protection — and that is exactly the
 * tenant that will one day need it. Meanwhile the page already promised restore
 * points are taken "apne aap roz". This makes the promise true.
 *
 * ─── ORDER OF THE GUARDS ────────────────────────────────────────────────────
 * Fail closed on a missing secret (503) BEFORE looking at the header, and use a
 * constant-time compare — the same shape as the other five crons here, on
 * purpose: an endpoint that snapshots every tenant is the last one that should
 * have its own bespoke auth.
 *
 * Local: curl -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/cron/backup
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { runSweepWithRetry } from "@/lib/backup/sweep-retry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: "cron not configured" }, { status: 503 });

  const header = req.headers.get("authorization") ?? "";
  const match  = /^Bearer\s+(.+)$/i.exec(header);
  if (!timingSafeEqualStr(match?.[1] ?? "", secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  /* Retried, because on 21 Aug 2026 this exact call answered "JWT issued at future"
   * once and the night's backup was simply never taken — the Cloud Scheduler job has
   * no retryCount, so nothing tried again until the next midnight. Only failures a
   * second attempt could survive are retried; see lib/backup/sweep-retry.ts, which
   * refuses to retry a bad grant or an unapplied migration on purpose. */
  const run = await runSweepWithRetry(async () => {
    const { data, error } = await admin.rpc("backup_all_tenants", { p_label: null });
    return error ? { ok: false as const, message: error.message } : { ok: true as const, data };
  });

  /* Logged even when the retry WORKED. A backup that only succeeds on the second try
   * is still a warning worth reading — silently absorbing it is how a clock drifting
   * further every night stays invisible until the night it exceeds the retry budget. */
  if (run.retriedBecause.length > 0) {
    console.warn(
      `[cron/backup] retried ${run.retriedBecause.length}x — ${run.retriedBecause.join(" | ")}`,
    );
  }

  if (!run.result.ok) {
    /* Keeps the "[cron/backup] sweep failed" prefix the 21 Aug incident was found by,
     * so any log filter or search built on it still matches — with the attempt count
     * added, which is the thing that was missing that night. */
    console.error(
      `[cron/backup] sweep failed after ${run.attemptsMade} attempt(s):`,
      run.result.message,
    );
    return NextResponse.json(
      { ok: false, error: run.result.message, attempts: run.attemptsMade },
      { status: 500 },
    );
  }

  const result = run.result.data;

  /* The function's `ok` is a COUNT of tenants; the response's `ok` is a boolean
   * for the caller. Spreading one over the other silently overwrote the count,
   * so the fields are mapped by hand and renamed to say what they are. */
  const body = {
    label:      result.label,
    backed_up:  result.ok,
    failed:     result.failed,
    total_bytes: result.total_bytes,
    results:    result.results,
  };

  /* A partial failure is reported, not swallowed. One tenant without tonight's
   * backup means the scheduler must see a non-2xx, or the run shows up green
   * with a note nobody reads. The tenants that DID succeed keep their snapshots
   * either way — the sweep never rolls back for one bad tenant. */
  if (result.failed > 0) {
    const broken = result.results.filter((r) => !r.ok).map((r) => `${r.tenant}: ${r.error}`);
    console.error("[cron/backup] some tenants failed:", broken.join(" | "));
    return NextResponse.json({ ok: false, ...body }, { status: 500 });
  }

  console.log(`[cron/backup] ${result.label} — ${result.ok} tenants, ${result.total_bytes} bytes`);
  return NextResponse.json({ ok: true, ...body });
}
