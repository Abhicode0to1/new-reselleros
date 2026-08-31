/**
 * Invoice dunning cron — runs daily.
 *
 * Chases invoices that have gone PAST their due date. This is a different job from
 * /api/cron/renewals, which counts DOWN to a subscription's renewal_date — see the
 * header of lib/invoices/dunning.ts for why running one engine on both clocks would
 * chase the wrong customers.
 *
 * Per unpaid invoice with a due date:
 *   1. decideDunning() → which step is due today (with a catch-up rule for a missed day)
 *   2. Already logged? do nothing.
 *   3. action 'email'    → send the customer the step's message
 *      action 'escalate' → tell the RESELLER; the customer is emailed the final notice too
 *      action 'suspend'  → pause the linked subscription (opt-in only; see below)
 *   4. Log what was actually done, which is not always what the step implies.
 *
 * AUTH FAILS CLOSED. This job emails customers and can pause subscriptions under the
 * service-role client. No CRON_SECRET configured means 503, not "run anyway".
 *
 * DRY RUN. `?dry=1` decides and reports without sending, suspending or logging, and
 * `?on=YYYY-MM-DD` time-travels the decision — accepted ONLY on a dry run, because a
 * live pass against a pretend calendar would email real customers about dates that
 * have not happened. Same reasoning as the renewals cron, and the same reason: a
 * quiet log looks identical whether the engine is healthy or completely broken.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { decideDunning, dunningMessage, dunningRank, type DunningStep } from "@/lib/invoices/dunning";
import { sendEmail, isEmailConfigured } from "@/lib/email/send";
import { dunningLogStatus, reachedNobody } from "@/lib/invoices/dunning-log-status";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { rupee, formatDate } from "@/lib/utils";
import { reportCron } from "@/lib/ops/cron-report";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface DunningResult {
  ran_at: string;
  dry_run: boolean;
  email_mode: "real" | "stub";
  considered: number;
  emails_sent: number;
  /**
   * Steps that reached NOBODY because the customer has no email on file.
   *
   * Reported separately from `emails_sent` because the two were previously
   * indistinguishable in the log: `invoice_dunning_log.status` was set from
   * `isEmailConfigured()`, so a step with no recipient was recorded as "sent". Two such
   * rows exist for INV-3BBD-2026-27-0002 (19 and 21 Aug 2026) and no email was sent for
   * either. A missing customer address is the reseller's to fix, and they cannot fix what
   * the cron reports as done.
   */
  no_recipient: number;
  escalations: number;
  suspends: number;
  skipped: number;
  details: { invoice_id: string; step: DunningStep; action: string; days_overdue: number; reason: string }[];
  errors: { invoice_id: string; message: string }[];
}

async function handle(req: Request): Promise<NextResponse<DunningResult | { error: string }>> {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry") === "1";
  const onParam = url.searchParams.get("on");
  if (onParam && !dryRun) {
    return NextResponse.json(
      { error: "?on= is only accepted with ?dry=1 — a live pass against a pretend date would email real customers." },
      { status: 400 },
    );
  }
  const asOf = onParam ? new Date(`${onParam}T12:00:00+05:30`) : new Date();

  const supabase = createAdminClient();
  const result: DunningResult = {
    ran_at: asOf.toISOString(),
    dry_run: dryRun,
    email_mode: isEmailConfigured() ? "real" : "stub",
    considered: 0, emails_sent: 0, no_recipient: 0, escalations: 0, suspends: 0, skipped: 0,
    details: [], errors: [],
  };

  /* Only invoices that could possibly be chased. 'paid'/'void'/'draft' and
     due-date-less rows are excluded in SQL rather than filtered in JS, so a tenant
     with thousands of settled invoices does not pay to load them. */
  const { data: invoices, error: invErr } = await supabase
    .from("invoices")
    .select("id, tenant_id, customer_id, customer_name, amount, paid_amount, status, due_date, quote_id")
    .in("status", ["pending", "overdue"])
    .not("due_date", "is", null);

  if (invErr) return NextResponse.json({ error: invErr.message }, { status: 500 });

  /* Tenant settings and the per-invoice dunning history, fetched once. A query per
     invoice would turn a 200-invoice pass into 400 round trips. */
  const tenantIds = [...new Set((invoices ?? []).map((i) => i.tenant_id))];
  const { data: tenants } = await supabase
    .from("tenants").select("id, name, email, auto_suspend_on_overdue").in("id", tenantIds);
  const tenantById = new Map((tenants ?? []).map((t) => [t.id, t]));

  const { data: logs } = await supabase
    .from("invoice_dunning_log")
    .select("invoice_id, dunning_step")
    .in("invoice_id", (invoices ?? []).map((i) => i.id));
  /* dunningRank() is IMPORTED, not redeclared. This block used to keep its own copy of
     the ordering, and the copy is exactly how adding `pre_due` would have broken it:
     an unknown key returns undefined, `undefined > 0` is false, so a nudge already in
     the log looks unsent and goes out again every morning until the invoice falls due.
     One definition, in the module that owns the ladder. */
  const lastStepByInvoice = new Map<string, DunningStep>();
  for (const l of logs ?? []) {
    const prev = lastStepByInvoice.get(l.invoice_id) ?? "none";
    if (dunningRank(l.dunning_step) > dunningRank(prev)) {
      lastStepByInvoice.set(l.invoice_id, l.dunning_step as DunningStep);
    }
  }

  for (const inv of invoices ?? []) {
    result.considered++;
    const tenant = tenantById.get(inv.tenant_id);

    /* A subscription is found through the invoice's source quote. No quote means no
       subscription, which decideDunning treats as "nothing to suspend". */
    let subscriptionId: string | null = null;
    if (inv.quote_id) {
      const { data: sub } = await supabase
        .from("subscriptions").select("id").eq("quote_id", inv.quote_id).maybeSingle();
      subscriptionId = sub?.id ?? null;
    }

    const amountDue = Math.max(0, (inv.amount ?? 0) - (inv.paid_amount ?? 0));
    const decision = decideDunning({
      dueDate: inv.due_date,
      status: inv.status,
      amountDue,
      lastStepSent: lastStepByInvoice.get(inv.id) ?? null,
      subscriptionId,
      autoSuspend: tenant?.auto_suspend_on_overdue ?? false,
    }, asOf);

    if (!decision.shouldSend || decision.action === "none") { result.skipped++; continue; }

    result.details.push({
      invoice_id: inv.id, step: decision.step, action: decision.action,
      days_overdue: decision.daysOverdue, reason: decision.reason,
    });

    if (dryRun) continue;

    try {
      // ── Customer email. Every step tells the customer something. ──────────
      const { data: customer } = inv.customer_id
        ? await supabase.from("customers").select("contact_email").eq("id", inv.customer_id).maybeSingle()
        : { data: null };
      const to = customer?.contact_email ?? null;

      const msg = dunningMessage({
        step: decision.step,
        invoiceId: inv.id,
        customerName: inv.customer_name,
        amountDue: rupee(amountDue),
        dueDate: formatDate(inv.due_date!),
        sellerName: tenant?.name ?? "your reseller",
        payLink: null,
        /* The REAL days remaining, from the decision — not the nominal 3. A pre-due
           nudge that fired late on day -1 must say "tomorrow"; "in 3 days" would be a
           false statement about money. Negative daysOverdue is the pre-due case. */
        daysUntilDue: decision.daysOverdue < 0 ? -decision.daysOverdue : null,
      });

      if (to && msg) {
        /* `automated` subjects this to the workspace's kill switch and dial (23 Aug 2026).
           Until then there was no way to stop this cron chasing customers except disabling
           a Cloud Scheduler job in a Google console.

           `emails_sent` is incremented only on a real send now — a refusal returns status
           "failed" with the reason, and counting it as sent would make the switch look
           broken in the very summary somebody checks after flipping it.

           The ESCALATION mail below is deliberately NOT gated: it goes to the reseller, not
           to a customer, and a switch that silenced the app's own alarms would turn one bad
           afternoon into a missed suspension. */
        const r = await sendEmail({
          /* Bina `route` ke ye default Resend par jata hai (send.ts:26), aur wo test mode
                me hai. Tenant ne Gmail chuna hai to mail wahi se jaye. */
          route: { tenantId: inv.tenant_id },
          to, subject: msg.subject, text: msg.text,
          kind: "invoice_dunning",
          automated: { tenantId: inv.tenant_id, action: "dunning.send" },
        });
        if (r.status !== "failed") result.emails_sent++;
      }

      // ── Reseller-side action ─────────────────────────────────────────────
      if (decision.action === "suspend" && subscriptionId) {
        const { error: suspErr } = await supabase
          .from("subscriptions")
          .update({ status: "paused", suspended_at: asOf.toISOString() })
          .eq("id", subscriptionId);
        if (suspErr) throw suspErr;
        result.suspends++;
      } else if (decision.action === "escalate") {
        /* The reseller decides. The email carries everything needed to decide
           without opening anything — §24: a notification that only says
           "something needs attention" costs a login to find out what. */
        if (tenant?.email) {
          await sendEmail({
            /* Bina `route` ke ye default Resend par jata hai (send.ts:26), aur wo test mode
                  me hai. Tenant ne Gmail chuna hai to mail wahi se jaye. */
            route: { tenantId: inv.tenant_id },
            to: tenant.email,
            subject: `${inv.customer_name} — invoice ${inv.id} is ${decision.daysOverdue} days overdue`,
            text:
`Invoice ${inv.id} for ${inv.customer_name} is ${decision.daysOverdue} days past due.

  Amount outstanding  ${rupee(amountDue)}
  Due date            ${formatDate(inv.due_date!)}
  Subscription        ${subscriptionId ?? "none — this invoice does not bill a subscription"}

${decision.reason}

The customer has had the full reminder sequence. Nothing further will be sent
automatically. Decide whether to call them, agree a plan, or pause the service.`,
          });
        }
        result.escalations++;
      }

      const logStatus = dunningLogStatus({
        recipient: to, hasMessage: Boolean(msg), emailConfigured: isEmailConfigured(),
      });
      if (reachedNobody(logStatus)) result.no_recipient++;

      await supabase.from("invoice_dunning_log").insert({
        tenant_id: inv.tenant_id,
        invoice_id: inv.id,
        dunning_step: decision.step,
        days_overdue: decision.daysOverdue,
        action_taken: decision.action,
        recipient_email: to,
        subject: msg?.subject ?? null,
        /* Truthful, not optimistic. See lib/invoices/dunning-log-status.ts: this used to be
           isEmailConfigured(), which answers whether Resend is set up rather than whether
           THIS message reached anybody — so a step with no customer address was logged as
           "sent". */
        status: logStatus,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      result.errors.push({ invoice_id: inv.id, message });
      /* Logged as failed so the next run RETRIES this step rather than treating it as
         delivered. A failure recorded as a success is a customer who is never chased. */
      await supabase.from("invoice_dunning_log").insert({
        tenant_id: inv.tenant_id, invoice_id: inv.id, dunning_step: decision.step,
        days_overdue: decision.daysOverdue, action_taken: decision.action,
        status: "failed", error_message: message.slice(0, 500),
      });
    }
  }

  return NextResponse.json(reportCron("invoice-dunning", result));
}

export async function GET(req: Request)  { return handle(req); }
export async function POST(req: Request) { return handle(req); }
