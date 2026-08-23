/**
 * GET  /api/ai/autonomy — what the app is allowed to do on its own, for this workspace.
 * PUT  /api/ai/autonomy — change it. Owner and manager only.
 *
 * ─── WHY A ROUTE AND NOT A CLIENT QUERY ─────────────────────────────────────
 * `ai_autonomy` is absent from the generated `Database` type, and adding it is not a
 * two-line fix: measured on 23 Aug 2026, registering ONE extra table in the Tables map took
 * `npm run typecheck` from 4 errors to 2,722, because supabase-js resolves row types through
 * a conditional chain that tips over the instantiation limit at this schema size and
 * collapses every table to `never`. Same reason `api/invoices/series` exists.
 *
 * ─── TENANT AND ROLE COME FROM THE SESSION, NEVER FROM THE BODY ─────────────
 * The writes below go through `lib/ai/autonomy.server`, which uses the SERVICE ROLE and so
 * bypasses RLS entirely. The `ai_autonomy_write` policy — owner/manager, same tenant —
 * therefore protects nothing on this path. The checks in this file ARE the boundary, which
 * is why the tenant is read out of the session and the role is checked here rather than
 * trusted from the caller.
 *
 * The policy still matters: it protects the table from anything holding a user session
 * directly, which is what it is for. Two doors, both locked, neither redundant.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { AI_ACTIONS, type AiAction, type AutonomyMode } from "@/lib/ai/autonomy";
import { loadAutonomyPolicy, setAutonomy, logAiAction } from "@/lib/ai/autonomy.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function whoami() {
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return null;
  const { data } = await supabase
    .from("users").select("tenant_id, role").eq("id", auth.user.id).single();
  const row = data as { tenant_id?: string | null; role?: string | null } | null;
  if (!row?.tenant_id) return null;
  return { userId: auth.user.id, tenantId: row.tenant_id, role: row.role ?? "" };
}

export async function GET() {
  const me = await whoami();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const policy = await loadAutonomyPolicy(me.tenantId);

  /* The registry travels with the policy, so the screen never hard-codes the list of
     actions or their labels. A page that keeps its own copy drifts the first time an action
     is added, and then shows a control for something that no longer exists. */
  return NextResponse.json({
    killSwitch: policy.killSwitch,
    canEdit:    me.role === "owner" || me.role === "manager",
    actions: (Object.keys(AI_ACTIONS) as AiAction[]).map((id) => ({
      id,
      label:    AI_ACTIONS[id].label,
      supports: AI_ACTIONS[id].supports,
      default:  AI_ACTIONS[id].today,
      mode:     policy.modes?.[id] ?? AI_ACTIONS[id].today,
      /* True when nothing is stored, so the screen can say "default" rather than implying
         somebody chose it. */
      isDefault: policy.modes?.[id] == null,
    })),
  }, { headers: { "cache-control": "no-store, max-age=0" } });
}

interface PutBody {
  killSwitch?: boolean;
  action?: string;
  mode?: string;
}

export async function PUT(request: NextRequest) {
  const me = await whoami();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (me.role !== "owner" && me.role !== "manager") {
    /* §24: says what is needed, not just "no". Turning automation on is a commercial
       decision and a sales user must not make it for the workspace. */
    return NextResponse.json(
      { error: "Only an owner or a manager can change automation settings. Ask one of them to change it for you." },
      { status: 403 },
    );
  }

  let body: PutBody;
  try { body = (await request.json()) as PutBody; }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  if (typeof body.killSwitch === "boolean") {
    const ok = await setAutonomy.killSwitch(me.tenantId, body.killSwitch, me.userId);
    if (!ok) {
      return NextResponse.json(
        { error: "Could not save the switch. Nothing changed — try again, and if it keeps failing the automation is still in whatever state it was." },
        { status: 500 },
      );
    }
    /* The switch itself is logged. Somebody reading the log a week later needs to know the
       gap was a decision and not an outage — which is the same reason a refused send is
       recorded rather than silently dropped. */
    await logAiAction({
      tenantId: me.tenantId,
      action:   "quote.send",
      outcome:  "skipped",
      reason:   body.killSwitch
        ? "a person switched ALL automation off for this workspace"
        : "a person switched automation back on for this workspace",
      mode:     body.killSwitch ? "off" : "auto",
      entity:   "workspace",
      entityId: me.tenantId,
      facts:    { killSwitch: body.killSwitch, changedBy: me.userId },
    });
    return NextResponse.json({ ok: true, killSwitch: body.killSwitch });
  }

  const action = (body.action ?? "") as AiAction;
  const mode   = (body.mode ?? "") as AutonomyMode;

  if (!(action in AI_ACTIONS)) {
    return NextResponse.json({ error: `Unknown action "${body.action}".` }, { status: 400 });
  }
  const spec = AI_ACTIONS[action];
  if (!(spec.supports as readonly string[]).includes(mode)) {
    /* Refused here rather than stored and reconciled later. resolveAutonomy would fall back
       and report it, but a setting the screen accepted and the engine ignores is worse than
       a rejection: the operator believes something untrue about their own workspace. */
    return NextResponse.json(
      { error: `"${spec.label}" cannot be set to "${body.mode}". It supports: ${spec.supports.join(", ")}.` },
      { status: 400 },
    );
  }

  const ok = await setAutonomy.mode(me.tenantId, action, mode, me.userId);
  if (!ok) {
    return NextResponse.json({ error: "Could not save that setting. Nothing changed." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, action, mode });
}
