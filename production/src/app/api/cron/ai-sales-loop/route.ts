/**
 * AI sales follow-up cron — drains `ai_sales_loops`.
 *
 * Schedule: hourly, via CLOUD SCHEDULER (scripts/setup-cloud-scheduler.sh). NOT vercel.json
 * — the live deployment is Cloud Run, where Vercel crons do not exist and that file is inert.
 * Local dev: `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/ai-sales-loop`.
 *
 * Hourly, not daily, because the agent schedules in HOURS (SALES_AGENT_SCHEMA bounds
 * in_hours at 1..720). A daily sweep would round every "chase them this afternoon" up to a
 * day and make the shortest useful follow-up impossible to express.
 *
 * What it does, for each due row:
 *   1. Re-read the lead. `shouldNudge` then decides whether the row is DUE or merely STALE —
 *      the customer may have replied, the deal may be won or lost, a person may have taken
 *      it over. See lib/ai/sales-loops.ts for why a timestamp comparison cannot know this.
 *   2. If it should nudge: run the agent with the trigger condition as its brief, and
 *      dispatch through the same path an inbound message uses.
 *   3. Close the row either way, with the outcome in words.
 *
 * ─── THE BRAKE APPLIES HERE TOO ─────────────────────────────────────────────
 * Every send goes through `dispatchSalesDecision`, so the autonomy dial and the kill switch
 * gate this cron exactly as they gate the webhook. `followup.send` is the action, and it
 * ships as `hold` — see lib/ai/autonomy.ts. Until somebody moves that dial this cron drafts
 * follow-ups onto lead timelines and sends nothing, which is the intended first state.
 *
 * ─── ONE LEAD CAN NEVER BE NUDGED TWICE BY ONE RUN ──────────────────────────
 * A unique partial index on (tenant_id, lead_id) WHERE status='pending' means one pending row
 * per lead, so the due list cannot contain the same lead twice. Idempotency across runs comes
 * from closing the row before the next sweep can see it.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { runSalesAgent, loadSalesCatalog } from "@/lib/ai/sales-agent.server";
import { dispatchSalesDecision } from "@/lib/ai/actions/quote-dispatcher";
import { shouldNudge } from "@/lib/ai/sales-loops";
import {
  closeLoop,
  lastCustomerMessageAt,
  loadDueLoops,
  loadLoopLead,
  scheduleSalesLoop,
} from "@/lib/ai/sales-loops.server";
import type { CatalogueItemPrice } from "@/lib/quotes/quote-from-enquiry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Bounded so one run cannot become an unbounded fan-out of model calls. */
const MAX_PER_RUN = 25;

const FROM_EMAIL =
  process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";

interface LoopOutcome {
  lead_id: string;
  result: string;
}

interface CronResult {
  ran_at: string;
  due: number;
  nudged: number;
  skipped: number;
  failed: number;
  outcomes: LoopOutcome[];
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}

async function handle(req: Request): Promise<NextResponse<CronResult | { error: string }>> {
  /* ── Auth — FAIL CLOSED ──────────────────────────────────────────────────
     503, not 401, when the secret is absent: "this deployment has no cron secret" is a
     missing-infrastructure fact for whoever is deploying, and reporting it as "unauthorized"
     sends them looking for a wrong credential instead of an unset one. Matches the seven
     existing crons. */
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  }
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  /* 503 as well, and for the same reason: with no service-role key the sweep would read zero
     rows and report a clean run, which is an absence dressed as a success. */
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not set — the follow-up sweep cannot read its own rows" },
      { status: 503 },
    );
  }

  const admin = createAdminClient();
  const now = new Date();
  const due = await loadDueLoops(MAX_PER_RUN, now);

  const result: CronResult = {
    ran_at: now.toISOString(),
    due: due.length,
    nudged: 0,
    skipped: 0,
    failed: 0,
    outcomes: [],
  };

  /* Catalogue per tenant, fetched once and reused — the due list is usually one workspace and
     re-reading `items` per lead would be a query per follow-up for no new information. */
  const catalogueByTenant = new Map<string, CatalogueItemPrice[]>();

  for (const loop of due) {
    try {
      /* Bare client, because `requires_human_attention` is not in the generated Database type
         — see loadLoopLead. That flag is the reason this read exists at all. */
      const read = await loadLoopLead({ tenantId: loop.tenantId, leadId: loop.leadId });

      if (!read.ok) {
        /* The composite FK cascades on lead delete, so a missing lead here means the read
           failed rather than the lead being gone. Close the row anyway: a loop that cannot
           find its lead will not find it on the next run either, and leaving it pending would
           make it a permanent resident of every future sweep. */
        result.failed++;
        result.outcomes.push({
          lead_id: loop.leadId,
          result: `could not read the lead — ${read.error}`,
        });
        await closeLoop({
          id: loop.id,
          tenantId: loop.tenantId,
          outcome: `closed unactioned — the lead could not be read (${read.error})`,
        });
        continue;
      }

      const lead = read.lead;

      const verdict = shouldNudge({
        stage: lead.stage,
        isJunk: lead.isJunk,
        requiresHumanAttention: lead.requiresHumanAttention,
        scheduledFrom: loop.createdAt,
        lastCustomerMessageAt: await lastCustomerMessageAt({
          tenantId: loop.tenantId,
          leadId: loop.leadId,
        }),
      });

      if (!verdict.nudge) {
        result.skipped++;
        result.outcomes.push({ lead_id: loop.leadId, result: `skipped — ${verdict.detail}` });
        await closeLoop({
          id: loop.id,
          tenantId: loop.tenantId,
          outcome: `no follow-up sent — ${verdict.detail}`,
        });
        /* On the timeline too. A follow-up that was scheduled and then deliberately not sent
           is a decision the operator should be able to see, not a silence. */
        await admin.from("lead_activities").insert({
          tenant_id: loop.tenantId,
          lead_id: loop.leadId,
          kind: "note",
          detail: `Automated follow-up cancelled — ${verdict.detail}`,
        });
        continue;
      }

      const channel = lead.contactEmail ? "email" : "whatsapp";
      const contact = lead.contactEmail ?? lead.contactPhone;
      if (!contact) {
        result.skipped++;
        result.outcomes.push({ lead_id: loop.leadId, result: "skipped — no email or phone on the lead" });
        await closeLoop({
          id: loop.id,
          tenantId: loop.tenantId,
          outcome: "no follow-up sent — the lead has neither an email address nor a phone number",
        });
        continue;
      }

      if (!catalogueByTenant.has(loop.tenantId)) {
        const cat = await loadSalesCatalog(admin, loop.tenantId);
        catalogueByTenant.set(
          loop.tenantId,
          cat.map((c) => ({
            id: c.sku,
            name: c.name,
            msrp: c.msrpPerSeatPerYear,
            wholesale: c.wholesalePerSeatPerYear,
          })),
        );
      }
      const catalogue = catalogueByTenant.get(loop.tenantId) ?? [];

      /* The trigger condition IS the brief. Passed as the incoming message so the follow-up
         can refer to what it is following up on — the difference between "checking in" and
         "you mentioned you needed the 20-seat figure before Thursday". */
      const run = await runSalesAgent({
        admin,
        tenantId: loop.tenantId,
        lead: {
          leadId: lead.id,
          company: lead.company ?? "Customer",
          contactName: lead.contactName ?? "",
          seats: lead.seats,
          plan: lead.plan,
          customerContact: contact,
          channel,
          existingQuoteId: null,
        },
        incoming:
          `[INTERNAL FOLLOW-UP BRIEF — the customer has not written since. Write a short, ` +
          `useful follow-up. Do not pretend they replied.] ${loop.triggerCondition}`,
        sellerName: "ANUTECH DIGITAL PVT LTD",
        sellerEmail: FROM_EMAIL,
      });

      if (!run.ok) {
        result.failed++;
        result.outcomes.push({ lead_id: loop.leadId, result: `agent failed — ${run.reason}` });
        await admin.from("lead_activities").insert({
          tenant_id: loop.tenantId,
          lead_id: loop.leadId,
          kind: "note",
          detail: `Automated follow-up could not be written — ${run.reason}`,
        });
        await closeLoop({
          id: loop.id,
          tenantId: loop.tenantId,
          outcome: `follow-up not written — ${run.reason}`,
        });
        continue;
      }

      const dispatched = await dispatchSalesDecision({
        admin,
        tenantId: loop.tenantId,
        leadId: lead.id,
        company: lead.company ?? "Customer",
        customerContact: contact,
        channel,
        decision: run.decision,
        /* followup.send, NOT reply.send. Chasing somebody who chose not to answer is a
           different permission from answering somebody who just wrote — see DispatchArgs. */
        sendAction: "followup.send",
        overruled: run.overruled,
        overruleReason: run.overruleReason,
        seats: lead.seats,
        catalogue,
        leadPlan: lead.plan,
        fromEmail: FROM_EMAIL,
        senderIsOurs: false,
        isSelfTest: false,
      });

      if (dispatched.outcome === "failed") result.failed++;
      else result.nudged++;

      result.outcomes.push({ lead_id: loop.leadId, result: dispatched.detail });
      await closeLoop({
        id: loop.id,
        tenantId: loop.tenantId,
        outcome: `follow-up ${dispatched.outcome} — ${dispatched.detail}`,
      });

      /* Chain the next one only if the agent asked for it. It closed the previous row itself,
         so there is no pending row to collide with the unique index. */
      if (dispatched.followUp) {
        await scheduleSalesLoop({
          tenantId: loop.tenantId,
          leadId: lead.id,
          inHours: dispatched.followUp.inHours,
          triggerCondition: dispatched.followUp.triggerCondition,
        });
      }
    } catch (err) {
      /* One bad lead must not end the sweep. Twenty-four other customers are waiting behind
         it, and a throw here would leave every one of them pending until the next hour. */
      const why = err instanceof Error ? err.message : "unknown error";
      console.error(`[cron/ai-sales-loop] lead ${loop.leadId} crashed:`, err);
      result.failed++;
      result.outcomes.push({ lead_id: loop.leadId, result: `crashed — ${why}` });
      await closeLoop({
        id: loop.id,
        tenantId: loop.tenantId,
        outcome: `follow-up crashed — ${why}`,
      }).catch(() => undefined);
    }
  }

  return NextResponse.json(result);
}
