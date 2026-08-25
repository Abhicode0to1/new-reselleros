/**
 * One inbound message, end to end: remember it, understand it, act on it, plan the next step.
 *
 * This is what the webhook calls. It REPLACES `runAutoReply` at both inbound-email branches,
 * and that is a deliberate swap rather than an addition — two drafters on one webhook means
 * two replies to one customer, which is the trust failure this repo cares most about. The
 * agent is a superset: same reply, plus a transcript, a quote decision, a handover rule and a
 * scheduled follow-up.
 *
 * ─── IT INHERITS THE THREE GATES runAutoReply FOUGHT FOR, BY REUSING THEM ────
 * `decideAutoReply` is called here with the agent's draft, unchanged. Its seven conditions are
 * the accumulated scar tissue of this path and none of them is re-derived:
 *
 *   theyWroteLast     — if OUR message is newest, nobody is waiting and a reply is the app
 *                       talking to itself in public
 *   alreadyReplied    — an outbound already newer than this inbound means this mail is answered
 *   humanIsHandlingIt — a PERSON touched the thread since the customer wrote, and a machine
 *                       chiming in over a colleague is worse than silence
 *
 * The three FACTS are gathered again below because `run-auto-reply.ts` keeps them inline and
 * `human-touch.test.ts` asserts on that file's source shape — extracting them would break a
 * test that exists to protect a subtle fix. So the queries are repeated and the DECISION is
 * not, which is the right half to duplicate. The `created_by IS NOT NULL` filter is the subtle
 * fix in question: every automated write here leaves it NULL, so without it the app's own
 * timeline notes count as "a person picked this up" and the reply holds with a wrong REASON.
 *
 * ─── ORDER OF OPERATIONS, AND WHY ───────────────────────────────────────────
 * 1. Record the customer's turn FIRST. If anything below fails, the message is still in the
 *    transcript and the next reply has it as context.
 * 2. Cancel any pending follow-up. They wrote — chasing them now would be pestering, and
 *    cancelling here means the row is gone before the cron can ever see it.
 * 3. Run the agent, apply the hard rules.
 * 4. Dispatch (or hand over).
 * 5. Schedule the next follow-up, if the agent asked for one.
 */
import { createClient as createBareClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { createAdminClient } from "@/lib/supabase/server";
import { decideAutoReply } from "./auto-reply";
import { runSalesAgent, loadSalesCatalog, recordSalesTurn } from "./sales-agent.server";
import { dispatchSalesDecision } from "./actions/quote-dispatcher";
import { cancelPendingLoops, scheduleSalesLoop } from "./sales-loops.server";
import { logAiAction } from "./autonomy.server";
import type { SalesChannel } from "./sales-agent";
import type { CatalogueItemPrice } from "@/lib/quotes/quote-from-enquiry";

type Admin = ReturnType<typeof createAdminClient>;

function bare(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

export interface RunSalesAgentArgs {
  admin: Admin;
  tenantId: string;
  leadId: string;
  /** The customer's message, quoted thread already stripped by the caller. */
  incoming: string;
  /** Where the message came from, and where a reply would go. */
  customerContact: string;
  channel: SalesChannel;
  senderIsOurs: boolean;
  isSelfTest: boolean;
  fromEmail: string;
  sellerName: string;
  /**
   * The enquiry arrived as a VOICE NOTE and `incoming` is a machine transcription.
   *
   * Threaded all the way to decideAutoSend rather than handled at the edge, because the
   * fact it changes is about the QUOTE — a seat count nobody typed — and the quote is built
   * four calls away from here. See lib/voice/voice-note.ts.
   */
  heardNotWritten?: boolean;
}

/**
 * Never throws. Called fire-and-forget from a webhook the provider is waiting on: the lead and
 * the message are committed before this runs, and losing a captured enquiry to protect a reply
 * would be the wrong trade — the provider would retry, the messageId claim would skip it as a
 * duplicate, and the mail would be gone.
 */
export async function runSalesAgentForLead(args: RunSalesAgentArgs): Promise<void> {
  const db = bare();
  if (!db) return;

  /* ── 0. The lead's own facts, read here rather than threaded through the webhook ──
     The two call sites sit in different branches with different variables in scope (`lf` on
     the append branch, the freshly-inserted row on create), and passing four fields from each
     is four chances for the branches to disagree about the same lead. One read here is also
     the FRESHER one: the append branch applies the reply's corrections — seats 20 → 50 — a few
     lines before calling this, and re-reading picks those up rather than the pre-correction
     values. */
  const { data: leadRow } = await args.admin
    .from("leads")
    .select("company, contact_name, seats, plan, gstin")
    .eq("id", args.leadId)
    .eq("tenant_id", args.tenantId)
    .maybeSingle();

  const lead = (leadRow ?? {}) as {
    company?: string | null;
    contact_name?: string | null;
    seats?: number | null;
    plan?: string | null;
    gstin?: string | null;
  };
  const company = lead.company ?? "Customer";
  const contactName = lead.contact_name ?? "";
  const seats = lead.seats ?? null;
  const leadPlan = lead.plan ?? null;

  /* ── 1. The customer's turn goes in first ── */
  await recordSalesTurn({
    tenantId: args.tenantId,
    leadId: args.leadId,
    channel: args.channel,
    customerContact: args.customerContact,
    role: "user",
    content: args.incoming,
  });

  /* ── 2. They wrote, so nothing should be chasing them ── */
  await cancelPendingLoops({
    tenantId: args.tenantId,
    leadId: args.leadId,
    reason: "the customer wrote back",
  });

  /* ── 3. Understand it ── */
  const quote = await latestQuote(args.admin, args.tenantId, args.leadId);

  const run = await runSalesAgent({
    admin: args.admin,
    tenantId: args.tenantId,
    lead: {
      leadId: args.leadId,
      company,
      contactName,
      seats,
      plan: leadPlan,
      customerContact: args.customerContact,
      channel: args.channel,
      existingQuoteId: quote.id,
      gstin: lead.gstin ?? null,
    },
    incoming: args.incoming,
    sellerName: args.sellerName,
    sellerEmail: args.fromEmail,
    extraAuthorisedTotals: quote.totals,
  });

  if (!run.ok) {
    /* The specific reason on the timeline. "The AI sales agent has no Gemini key" is fixed on
       a settings page; "agent failed" is fixed by asking an engineer. */
    await args.admin.from("lead_activities").insert({
      tenant_id: args.tenantId,
      lead_id: args.leadId,
      kind: "note",
      detail: `AI sales agent could not answer this message — ${run.reason}`,
    });
    await logAiAction({
      tenantId: args.tenantId,
      action: "reply.send",
      outcome: "failed",
      reason: run.reason,
      mode: "hold",
      entity: "lead",
      entityId: args.leadId,
      facts: { channel: args.channel },
    });
    return;
  }

  /* ── 4. The inherited gates. Skipped for a handover, which sends nothing anyway ── */
  if (run.decision.action_required !== "HANDOVER_TO_HUMAN") {
    const gate = await checkReplyGates({
      db,
      tenantId: args.tenantId,
      leadId: args.leadId,
      senderIsOurs: args.senderIsOurs,
      isSelfTest: args.isSelfTest,
      draft: {
        subject: run.decision.generated_response.email_subject,
        message: run.decision.generated_response.body_text,
      },
    });

    if (!gate.send) {
      /* The draft on the timeline, where an operator already looks. A held reply that only
         logged "held" would say it happened and never what it would have said. */
      await args.admin.from("lead_activities").insert({
        tenant_id: args.tenantId,
        lead_id: args.leadId,
        kind: "note",
        detail:
          `AI sales agent drafted a reply and did NOT send it — ${gate.reason}\n\n` +
          `Subject: ${run.decision.generated_response.email_subject}\n\n` +
          run.decision.generated_response.body_text,
      });
      await logAiAction({
        tenantId: args.tenantId,
        action: "reply.send",
        outcome: "held",
        reason: gate.reason,
        mode: "hold",
        entity: "lead",
        entityId: args.leadId,
        facts: {
          channel: args.channel,
          intent: run.decision.customer_intent,
          confidence: run.decision.confidence_score,
        },
      });
      return;
    }
  }

  /* ── 5. Act ── */
  const catalogue: CatalogueItemPrice[] = (
    await loadSalesCatalog(args.admin, args.tenantId)
  ).map((c) => ({
    id: c.sku,
    name: c.name,
    msrp: c.msrpPerSeatPerYear,
    wholesale: c.wholesalePerSeatPerYear,
  }));

  const dispatched = await dispatchSalesDecision({
    admin: args.admin,
    tenantId: args.tenantId,
    leadId: args.leadId,
    company,
    customerContact: args.customerContact,
    channel: args.channel,
    decision: run.decision,
    sendAction: "reply.send",
    overruled: run.overruled,
    overruleReason: run.overruleReason,
    seats,
    catalogue,
    leadPlan,
    fromEmail: args.fromEmail,
    senderIsOurs: args.senderIsOurs,
    isSelfTest: args.isSelfTest,
    heardNotWritten: args.heardNotWritten,
  });

  /* ── 6. Plan the next touch ── */
  if (dispatched.followUp) {
    await scheduleSalesLoop({
      tenantId: args.tenantId,
      leadId: args.leadId,
      inHours: dispatched.followUp.inHours,
      triggerCondition: dispatched.followUp.triggerCondition,
    });
  }
}

/**
 * The newest quote on this lead — its id, so the agent does not offer a second one, and its
 * FIGURES, so the agent may state the amount it is writing a covering email about.
 *
 * The figures matter as much as the id. Until 24 Aug 2026 the agent could name the quote by
 * number and not say what it was for: a total is arithmetic, arithmetic is not authorised, and
 * every quote email handed over. These two numbers come from the quote row itself — computed by
 * planQuoteFromEnquiry, not by the model — so they are facts, not guesses.
 */
async function latestQuote(
  admin: Admin,
  tenantId: string,
  leadId: string,
): Promise<{ id: string | null; totals: number[] }> {
  const { data } = await admin
    .from("quotes")
    .select("id, subtotal, amount")
    .eq("tenant_id", tenantId)
    .eq("lead_id", leadId)
    .order("created_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  const row = data as { id?: string; subtotal?: number | null; amount?: number | null } | null;
  if (!row?.id) return { id: null, totals: [] };

  /* Both, because a covering email legitimately says either the pre-GST subtotal or the gross.
     Zero and null are dropped rather than authorised: "0" is already always allowed by the
     money guard, and a null figure is a quote that was not priced. */
  const totals = [row.subtotal, row.amount].flatMap((n) =>
    typeof n === "number" && n > 0 ? [Math.round(n)] : [],
  );
  return { id: row.id, totals };
}

/**
 * The three facts `decideAutoReply` needs, read fresh.
 *
 * See the file header for why these queries are repeated from run-auto-reply.ts rather than
 * extracted: `human-touch.test.ts` pins that file's source shape to protect the
 * `created_by IS NOT NULL` fix, and moving the code would break the test guarding it.
 */
async function checkReplyGates(args: {
  db: SupabaseClient;
  tenantId: string;
  leadId: string;
  senderIsOurs: boolean;
  isSelfTest: boolean;
  draft: { subject: string; message: string };
}): Promise<{ send: boolean; reason: string }> {
  const { db, tenantId, leadId } = args;

  const { data: inboundLatest } = await db
    .from("inbound_emails")
    .select("created_at, status")
    .eq("tenant_id", tenantId)
    .eq("lead_id", leadId)
    .neq("status", "reply_sent")
    .order("created_at", { ascending: false })
    .limit(1);

  const { data: outbound } = await db
    .from("inbound_emails")
    .select("created_at")
    .eq("tenant_id", tenantId)
    .eq("lead_id", leadId)
    .eq("status", "reply_sent")
    .order("created_at", { ascending: false })
    .limit(1);

  const lastIn = (inboundLatest ?? [])[0] as { created_at?: string } | undefined;
  const lastOut = (outbound ?? [])[0] as { created_at?: string } | undefined;

  const alreadyReplied = Boolean(
    lastOut?.created_at && lastIn?.created_at && lastOut.created_at > lastIn.created_at,
  );

  /* A PERSON, not this app's own footprints. `created_by IS NOT NULL` is the whole fix:
     automated writes here leave it NULL (the bare service-role client cannot know a user)
     while anything a human does goes through the `log_lead_activity` RPC, which stamps
     `auth.uid()`. Without it, the webhook's own note — written a fraction of a second
     earlier — counts as a colleague and the reply holds saying somebody picked the thread up
     when nobody had. */
  const { data: humanTouch } = await db
    .from("lead_activities")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("lead_id", leadId)
    .in("kind", ["call", "whatsapp", "note", "email_out"])
    .not("created_by", "is", null)
    .gt("created_at", lastIn?.created_at ?? "1970-01-01")
    .limit(1);

  const decision = decideAutoReply({
    senderIsOurs: args.senderIsOurs,
    isSelfTest: args.isSelfTest,
    /* The customer's message is what triggered this run and it was just recorded, so they
       wrote last unless an outbound landed after it. */
    theyWroteLast: !alreadyReplied,
    alreadyReplied,
    humanIsHandlingIt: (humanTouch ?? []).length > 0,
    draft: args.draft,
    /* The agent only ever writes for THIS lead — there is no template path. A generic
       fallback is exactly what `runSalesAgent` refuses to produce: with no key or no
       catalogue it returns `ok: false` and this function is never reached. */
    draftIsForThisLead: true,
    /* `applyHandoverRules` has already checked this draft's money against the CATALOGUE and
       its promises against the three kinds no price list can excuse, and would have overruled
       the model to HANDOVER_TO_HUMAN on any failure — so a draft that reaches here has passed
       a stricter check than `findPromises` can make.

       Without this the gate refused every priced reply, and because it sits UPSTREAM of the
       dispatcher it did so at ANY dial setting: `reply.send = auto` would have changed
       nothing. Measured on the first live enquiry, 24 Aug 2026 — see the field's own comment
       in auto-reply.ts. The other six conditions in `decideAutoReply` still run, and they are
       the ones this path needs it for. */
    promisesAlreadyChecked: true,
  });

  return { send: decision.send, reason: decision.reason };
}
