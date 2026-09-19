/**
 * GET|POST /api/cron/hosting-suspend — make DirectAdmin match our record.
 *
 * Schedule: every 15 minutes. This is the second half of a decision the database
 * has already made, and until it runs the decision is only on paper.
 *
 * ─── THE PATH SAYS "SUSPEND"; THE JOB IS BOTH DIRECTIONS ────────────────────
 * It suspends AND restores. The name is from 11 Sep, when suspending was all it
 * did; the restore half arrived the same day, once it became clear that
 * `refund_payment` could take an account off and nothing in the app could put it
 * back — `daUnsuspendAccount` existed with no caller anywhere.
 *
 * One job and one queue rather than two, deliberately. Both directions are
 * driven by the same `next_action_at` column, so splitting them would mean two
 * scheduled jobs polling one column with opposite filters, racing on the same
 * rows. The path is left alone so the Cloud Scheduler entry stays valid.
 *
 * ─── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 * `refund_payment` suspends hosting when a refund takes the last of the money off
 * a quote (Pardeep, 11 Sep 2026: "Suspend the hosting but don't delete it. Admin
 * will decide to delete it."). But that is a database transaction, and taking a
 * website offline is a network call to DirectAdmin, which cannot happen inside
 * one. So the RPC marks the row and stamps `next_action_at`, and this route is
 * what actually shuts the site down.
 *
 * The state in between is the dangerous one and it is worth naming: the books say
 * suspended, the customer's site is still serving, and the money has gone back.
 * Every minute this route does not run is a minute in that state. That is why it
 * is scheduled at 15 minutes rather than daily.
 *
 * ─── IT NEVER DELETES ───────────────────────────────────────────────────────
 * `daDeleteAccount` exists in the same module and is NOT imported here, on
 * purpose. This route has no delete path, no "terminate after N days", and no
 * cleanup mode. Deleting a customer's site and mailboxes is a decision a person
 * makes; a scheduled job must never be the thing that makes it.
 *
 * ─── WHICH DIRECTION IS NOT DECIDED HERE ────────────────────────────────────
 * `serverIntentFor` decides, in `lib/hosting/suspension-intent.ts`, with its own
 * tests. Because the two actions are opposites on somebody's live hosting chosen
 * by one comparison: invert it and this job suspends every ACTIVE account with a
 * queued action, which would look like a mass outage with no error anywhere. The
 * dispatch below only acts on the answer.
 *
 * ─── AN UNCONFIGURED SERVER IS NOT A FINISHED JOB ────────────────────────────
 * If DirectAdmin credentials are missing, the row is left with its
 * `next_action_at` intact and the run says so. It is tempting to clear the date
 * and move on — the row already reads `suspended`, so nothing looks wrong. That
 * would be the worst outcome available: the one durable record that the server
 * still has to be told would be erased, and the site would stay up forever with
 * every screen claiming otherwise. The work stays queued until it is really done.
 *
 * ─── WHY A FAILURE BACKS OFF INSTEAD OF RETRYING HARD ────────────────────────
 * `attempt_count` grows and the next attempt moves further out (15m, 1h, 4h,
 * then daily). A DirectAdmin box that is refusing our IP will refuse it again in
 * fifteen minutes, and hammering it turns one problem into two. The failure is
 * recorded on the row — `last_error`, `last_error_at`, `last_error_kind` — which
 * is what `/assets/hosting` reads, so a stuck suspension is visible to a person
 * rather than only to a log.
 *
 * The delay arithmetic lives in `lib/hosting/suspend-backoff.ts` with its tests,
 * because it is the only thing in this file that can be wrong SILENTLY — an
 * out-of-range attempt count returning `undefined` would make
 * `new Date(NaN).toISOString()` throw, the row would keep its old due date, and
 * the item would come back on every single run against a server already
 * refusing us.
 */
import { NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { daSuspendAccount, daUnsuspendAccount, daWriteConfigured } from "@/lib/directadmin/provision";
import { serverIntentFor, type HostingSuspensionStatus } from "@/lib/hosting/suspension-intent";
import { nextSuspendAttemptAt } from "@/lib/hosting/suspend-backoff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Per run. Small on purpose: each item is one write to somebody's live server. */
const BATCH = 25;

async function authorized(req: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
    if (timingSafeEqualStr(m?.[1] ?? "", secret)) return true;
  }
  try {
    const supabase = createClient();
    const { data: authData } = await supabase.auth.getUser();
    if (!authData?.user) return false;
    const { data: me } = await supabase.from("users").select("role").eq("id", authData.user.id).single();
    return me?.role === "owner";
  } catch {
    return false;
  }
}

async function handle(req: Request): Promise<NextResponse> {
  if (!(await authorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const admin = createAdminClient();

  const result = {
    ran_at: nowIso,
    due: 0,
    suspended_on_server: 0,
    restored_on_server: 0,
    failed: 0,
    left_queued: 0,
    skipped: 0,
    server: "" as string,
    /* Named, not counted. "3 failed" cannot be acted on. */
    failures: [] as Array<{ domain: string; action: string; reason: string }>,
    still_waiting: [] as string[],
    /* Why a due row was not acted on. Without this a run reading
       "17 due, 0 sent" looks like a broken job. */
    skipped_reasons: [] as string[],
  };

  /* Rows where our record and the server disagree, in EITHER direction.
     A due `next_action_at` is what says "the server has not been told"; the
     status says which way. Both are read here and `serverIntentFor` decides —
     the query no longer filters on status, because filtering it here would put
     the direction rule in two places. */
  const { data: due, error } = await admin
    .from("hosting_accounts")
    .select("id, domain_name, status, da_username, attempt_count, next_action_at, deleted_at")
    .is("deleted_at", null)
    .not("next_action_at", "is", null)
    .lte("next_action_at", nowIso)
    .order("next_action_at", { ascending: true })
    .limit(BATCH);

  if (error) {
    console.error("[hosting-suspend] could not read the queue:", error.message);
    return NextResponse.json({ error: "could not read the queue" }, { status: 500 });
  }

  result.due = due?.length ?? 0;

  if (!daWriteConfigured()) {
    /* Deliberately no writes at all — see the header. The queue keeps its dates
       so this becomes a no-op the day credentials arrive, rather than a backlog
       that was silently thrown away. */
    result.server = "DirectAdmin is not configured — nothing was sent and nothing was cleared";
    result.left_queued = result.due;
    result.still_waiting = (due ?? []).map((h) => h.domain_name);
    return NextResponse.json({ ran: true, ...result });
  }
  result.server = "DirectAdmin is configured";

  for (const h of due ?? []) {
    const intent = serverIntentFor({
      status: h.status as HostingSuspensionStatus,
      nextActionAt: h.next_action_at,
      daUsername: h.da_username,
      deletedAt: h.deleted_at,
      now,
    });

    if (intent.action === "none") {
      /* Two shapes of "nothing to do", and they need opposite handling.

         A row with no DirectAdmin username has nothing on the server in either
         direction, and no amount of retrying will find an account that does not
         exist — so the date is CLEARED and the row stops coming back.

         Everything else (a status this job cannot act on) keeps its date. The
         status may yet change to one that can be acted on, and throwing the
         queue entry away would lose the fact that the server still needs
         telling. */
      if (!h.da_username) {
        await admin.from("hosting_accounts").update({ next_action_at: null }).eq("id", h.id);
      }
      result.skipped++;
      result.skipped_reasons.push(`${h.domain_name}: ${intent.reason}`);
      continue;
    }

    let ok = false;
    let reason = "";
    try {
      /* The ONLY place the two directions diverge. `h.da_username` is non-null
         here — `serverIntentFor` refuses without it. */
      const r =
        intent.action === "suspend"
          ? await daSuspendAccount(h.da_username as string)
          : await daUnsuspendAccount(h.da_username as string);
      ok = r.ok;
      reason = r.message;
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }

    if (ok) {
      await admin
        .from("hosting_accounts")
        .update({
          /* The whole point of the run: nothing left to do for this row. */
          next_action_at: null,
          last_synced_at: nowIso,
          last_error: null,
          last_error_at: null,
          last_error_kind: null,
        })
        .eq("id", h.id);
      if (intent.action === "suspend") result.suspended_on_server++;
      else result.restored_on_server++;
      continue;
    }

    const attempts = (h.attempt_count ?? 0) + 1;
    await admin
      .from("hosting_accounts")
      .update({
        attempt_count: attempts,
        last_attempt_at: nowIso,
        next_action_at: nextSuspendAttemptAt(attempts, now),
        last_error: `${intent.action === "suspend" ? "Suspend" : "Restore"} failed: ${reason}`.slice(0, 500),
        last_error_at: nowIso,
        /* `server_unreachable` and not `hard_failure`: the account still exists
           and the intent is still valid, which is what makes this retryable.
           The status check constraint only allows the three kinds — see
           hosting_accounts_last_error_kind_check. */
        last_error_kind: "server_unreachable",
      })
      .eq("id", h.id);

    console.error(`[hosting-suspend] ${intent.action} ${h.domain_name} (${h.da_username}): ${reason}`);
    result.failed++;
    result.failures.push({ domain: h.domain_name, action: intent.action, reason });
  }

  return NextResponse.json({ ran: true, ...result });
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
