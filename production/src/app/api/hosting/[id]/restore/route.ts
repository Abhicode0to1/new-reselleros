/**
 * POST /api/hosting/:id/restore — put a suspended hosting account back on.
 *
 * ─── THE GAP THIS CLOSES, AND WHO OPENED IT ─────────────────────────────────
 * On 11 Sep 2026 `refund_payment` gained the power to suspend hosting when a
 * refund takes the last of the money off a quote. Nothing in the app could put it
 * back. `daUnsuspendAccount` had existed since the 9 Sep port with no caller
 * anywhere, and its own comment claimed it was "used when a trial converts to
 * paid" — there was no such caller either.
 *
 * So a refund raised in error, or a customer who paid again by bank transfer,
 * left an operator with one option: log into DirectAdmin and un-suspend by hand,
 * with our record still saying `suspended` afterwards. That is the drift this
 * whole subsystem exists to avoid.
 *
 * ─── WHY THIS NEEDS NO CONFIRMATION FLOW, UNLIKE ITS SIBLINGS ───────────────
 * `/assets/hosting/[id]` says suspend and terminate are deliberately not wired
 * to a button because they want a confirmation somebody has agreed to. Restoring
 * is the opposite direction: it destroys nothing, it is itself reversible, and
 * the worst case is a customer gets service they have not paid for — which the
 * operator can undo. A confirmation dialog on the SAFE action while the
 * dangerous ones stay unwired would be ceremony in the wrong place.
 *
 * It is still fully audited, because "why is this account back on after a
 * refund?" is a question somebody will ask six months later.
 *
 * ─── IT DOES NOT TOUCH THE SERVER ITSELF ────────────────────────────────────
 * It marks the row and stamps `next_action_at`; `/api/cron/hosting-suspend`
 * makes DirectAdmin match. Same shape as the suspend half, and for the same
 * reason: one queue, one place that talks to the server, and one place that
 * handles a server that is down.
 *
 * The consequence is worth stating plainly in the response, and it is: the site
 * does NOT come back the instant this returns. It comes back within the quarter
 * hour, or the row keeps its error and a person sees it.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  /** Optional, but recorded either way — see the audit note below. */
  reason: z.string().trim().max(500).optional(),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const userClient = createClient();
  const { data: authData } = await userClient.auth.getUser();
  if (!authData?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: me } = await userClient
    .from("users")
    .select("tenant_id, role, full_name")
    .eq("id", authData.user.id)
    .single();
  if (!me?.tenant_id) {
    return NextResponse.json({ error: "user not linked to a tenant" }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = bodySchema.safeParse(raw);
  const reason = parsed.success ? parsed.data.reason?.trim() : undefined;

  const admin = createAdminClient();
  const { data: account } = await admin
    .from("hosting_accounts")
    .select("id, tenant_id, domain_name, status, da_username, suspended_at")
    .eq("id", params.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (!account) return NextResponse.json({ error: "hosting account not found" }, { status: 404 });
  /* Tenant scope enforced here and not left to RLS: this route uses the admin
     client so it can stamp the queue, and the admin client bypasses RLS. */
  if (account.tenant_id !== me.tenant_id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (account.status !== "suspended") {
    /* §24 — each state gets the sentence that tells the operator what to do
       instead, rather than one "cannot restore". */
    const why: Record<string, string> = {
      active: "This account is already active. If the site is still down, check the last error on this page — the server may not have been told yet.",
      pending: "This account has never been provisioned, so there is nothing to restore. Provision it instead.",
      expired: "This account has lapsed rather than been suspended. Renew it to bring it back.",
      terminated: "This account has been closed. Restoring is not possible — sell a new one.",
      failed: "Provisioning never succeeded for this account, so there is nothing on the server to restore. Fix the provisioning failure first.",
    };
    return NextResponse.json(
      {
        error: `This account is ${account.status}, not suspended.`,
        nextStep: why[account.status] ?? "Only a suspended account can be restored.",
      },
      { status: 409 },
    );
  }

  if (!account.da_username) {
    return NextResponse.json(
      {
        error: "This account has no DirectAdmin username on it, so there is nothing on the server to restore.",
        nextStep: "Check whether it was ever really provisioned before restoring it here.",
      },
      { status: 409 },
    );
  }

  const nowIso = new Date().toISOString();

  const { error: updErr } = await admin
    .from("hosting_accounts")
    .update({
      status: "active",
      /* Cleared: it records WHEN the account went off, and it is back on. The
         audit row below is what preserves the history. */
      suspended_at: null,
      /* Due now. The cron tells DirectAdmin — see the header. */
      next_action_at: nowIso,
      /* A fresh intent gets a fresh attempt count, or a previous suspend's
         failures would push the restore straight into a day-long back-off. */
      attempt_count: 0,
      last_error: null,
      last_error_at: null,
      last_error_kind: null,
    })
    .eq("id", params.id)
    /* Conditional on it still being suspended: two operators pressing Restore at
       once would otherwise both stamp the queue and both report success. */
    .eq("status", "suspended");

  if (updErr) {
    console.error("[hosting/restore]", updErr.message);
    return NextResponse.json({ error: "Could not restore that just now." }, { status: 500 });
  }

  /* Durable audit. `activity_log.user_id` references `users`, and this route
     already proved the caller is one, so the id is safe to use here — unlike the
     portal's own audit rows, which must pass null. */
  const { error: auditErr } = await admin.from("activity_log").insert({
    tenant_id: account.tenant_id,
    user_id: authData.user.id,
    action: "hosting.restored",
    entity: "hosting_account",
    entity_id: account.id,
    label:
      `${me.full_name ?? "A staff user"} restored ${account.domain_name} (suspended ` +
      `${account.suspended_at?.slice(0, 10) ?? "at an unrecorded time"}). ` +
      (reason ? `Reason: ${reason}` : "No reason given."),
  });
  if (auditErr) console.error("[hosting/restore] audit row failed:", auditErr.message);

  return NextResponse.json({
    ok: true,
    domain: account.domain_name,
    /* Said out loud: the row is active NOW, the site is not. */
    message: `${account.domain_name} is marked active. The server is told within 15 minutes — if that fails you will see the error on this page.`,
    audited: !auditErr,
  });
}
