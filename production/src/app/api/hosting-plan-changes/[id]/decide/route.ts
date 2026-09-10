/**
 * POST /api/hosting-plan-changes/[id]/decide
 *
 * A rep approving or rejecting a customer's hosting upgrade request.
 *
 * The hosting twin of `/api/seat-requests/[id]/decide`, and it keeps every one of
 * that route's four disciplines, because they were each learned from a real
 * failure and none of them is specific to seats.
 *
 * ─── APPROVING *IS* APPLYING ────────────────────────────────────────────────
 * There is no "approved but not yet done" state. Approval moves the DirectAdmin
 * package, updates our record, moves the subscription's recurring rate, and
 * raises the pro-rata quote — see `lib/hosting/apply-plan-upgrade.ts`. A status
 * meaning "we said yes but nothing happened" is the ambiguity this table replaced
 * tickets to remove.
 *
 * ─── THE GUARDS RUN SERVER-SIDE, NOT ONLY IN THE UI ─────────────────────────
 * `assessPlanChange` decides whether this request can be approved at all: the
 * account may have been moved by hand since it was raised, suspended, closed, or
 * the request may be a downgrade. The queue shows the same verdict, but a disabled
 * button is not a guard — this is. It could be approved from a stale tab.
 *
 * ─── THE STATUS IS WRITTEN ONLY AFTER THE PLAN HAS MOVED ────────────────────
 * If the package change fails, the request stays `pending`. Marking it approved
 * first would leave a request that says "done" over an account nobody changed, and
 * the customer would be told their bigger plan was ready.
 *
 * ─── A PARTIAL SUCCESS IS REPORTED, NOT SWALLOWED ───────────────────────────
 * The server can move and the money then fail. That state is real, it is not
 * undoable from here, and the honest thing is to hand it to a person with the
 * amount in the sentence — exactly what the seat route does with its `warning`.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { assessPlanChange, type HostingStatusForChange } from "@/lib/hosting/plan-change";
import { applyPlanUpgrade } from "@/lib/hosting/apply-plan-upgrade";
import { localDateISO } from "@/lib/leads/outcomes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(1000).optional(),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const userClient = createClient();
  const { data: authData } = await userClient.auth.getUser();
  if (!authData?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: me } = await userClient
    .from("users")
    .select("tenant_id")
    .eq("id", authData.user.id)
    .single();
  if (!me?.tenant_id) return NextResponse.json({ error: "user not linked to a tenant" }, { status: 403 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "decision must be 'approved' or 'rejected'" }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: request, error: reqErr } = await supabase
    .from("hosting_plan_changes")
    .select("*")
    .eq("id", params.id)
    .single();
  if (reqErr || !request) return NextResponse.json({ error: "request not found" }, { status: 404 });
  if (request.tenant_id !== me.tenant_id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (request.status !== "pending") {
    return NextResponse.json({ error: `This request is already ${request.status}.` }, { status: 409 });
  }

  const nowIso = new Date().toISOString();

  // ── Rejection: a status change and a note the customer will read. ─────────
  if (parsed.data.decision === "rejected") {
    const { error } = await supabase
      .from("hosting_plan_changes")
      .update({
        status: "rejected",
        decided_by: authData.user.id,
        decided_at: nowIso,
        decision_note: parsed.data.note ?? null,
      })
      .eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, status: "rejected" });
  }

  // ── Approval ──────────────────────────────────────────────────────────────
  const { data: account, error: acctErr } = await supabase
    .from("hosting_accounts")
    .select(
      "id, tenant_id, customer_id, domain_name, status, is_trial, plan_code, plan_name, da_package, da_username, subscription_id, expires_at, started_at",
    )
    .eq("id", request.hosting_account_id)
    .is("deleted_at", null)
    .single();
  if (acctErr || !account) {
    return NextResponse.json({ error: "hosting account not found" }, { status: 404 });
  }

  /* The same verdict the queue shows, enforced here. `livePlanCode` is read from
     the account NOW, which is what catches a plan somebody changed by hand after
     this request was raised. */
  const verdict = assessPlanChange({
    status: "pending",
    fromPlanCode: request.from_plan_code,
    requestedPlanCode: request.requested_plan_code,
    livePlanCode: account.plan_code ?? account.da_package ?? account.plan_name,
    hostingStatus: account.status as HostingStatusForChange,
    /* Read from the account, not the request. A request raised before the trial
       guard existed is still in the table and must not be approvable. */
    isTrial: !!account.is_trial,
  });

  if (!verdict.canApprove) {
    /* 409, not 400: nothing about the request is malformed — the world moved. The
       reason and the next step both go back so the UI can show them verbatim. */
    return NextResponse.json({ error: verdict.reason, nextStep: verdict.nextStep }, { status: 409 });
  }

  const { data: tenant } = await supabase
    .from("tenants")
    .select("grace_period_days")
    .eq("id", account.tenant_id)
    .single();

  const result = await applyPlanUpgrade({
    supabase,
    account: {
      id: account.id,
      tenant_id: account.tenant_id,
      customer_id: account.customer_id,
      domain_name: account.domain_name,
      da_username: account.da_username,
      subscription_id: account.subscription_id,
      expires_at: account.expires_at,
      started_at: account.started_at,
    },
    from: verdict.from,
    to: verdict.to,
    todayISO: localDateISO(new Date()),
    graceDays: tenant?.grace_period_days ?? 7,
  });

  if (!result.ok) {
    /* The request stays pending. It can be approved again once whatever failed is
       fixed, and it does not sit there claiming to be done. */
    return NextResponse.json({ error: result.message, code: result.code }, { status: 400 });
  }

  const { error: markErr } = await supabase
    .from("hosting_plan_changes")
    .update({
      status: "approved",
      quote_id: result.quoteId,
      decided_by: authData.user.id,
      decided_at: nowIso,
      decision_note: parsed.data.note ?? null,
      /* The plan IS live on the server at this point. */
      applied_at: nowIso,
      da_result: `Moved to ${result.newPlan}`,
    })
    .eq("id", params.id);

  if (markErr) {
    /* The package IS changed and the quote IS raised — neither can be undone
       here, and pretending otherwise would be worse. Report the real state so a
       human closes the request rather than approving it twice. */
    console.error(
      `[hosting-plan-changes] ${account.domain_name} moved to ${result.newPlan} (quote ${result.quoteId ?? "none"}) but request ${params.id} not marked:`,
      markErr,
    );
    return NextResponse.json({
      ok: true,
      status: "approved",
      quoteId: result.quoteId,
      amount: result.amount,
      newPlan: result.newPlan,
      warning: `${account.domain_name} is on ${result.newPlan} and quote ${result.quoteId ?? "(none)"} was raised, but this request could not be marked approved. Close it by hand — do not approve it again.`,
    });
  }

  return NextResponse.json({
    ok: true,
    status: "approved",
    quoteId: result.quoteId,
    amount: result.amount,
    proRataDays: result.proRataDays,
    termDays: result.termDays,
    newPlan: result.newPlan,
    /* Both carried through verbatim. Each one means the plan is live and
       something about the money is not, which is a sentence a person has to
       read — see the module header. */
    warning: result.quoteFailed ?? result.renewalRateFailed ?? undefined,
  });
}
