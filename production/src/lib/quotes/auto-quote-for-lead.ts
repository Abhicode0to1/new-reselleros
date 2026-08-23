/**
 * Draft a quote for a lead from what an inbound mail said, and send it if the rules allow.
 *
 * ─── WHY THIS IS A FUNCTION AND NOT 130 LINES IN THE WEBHOOK ─────────────────
 * Because it has to run on TWO branches and it only ran on one. Measured on a live
 * self-test, 23 Aug 2026: a mail asking for "50 Google Workspace Business Starter users on
 * annual billing" arrived from an address that already had an open lead, so the webhook
 * appended it — correctly — and drafted nothing, because the quote block sat inside the
 * CREATE branch alone. The extractor had done its job: seats 20 → 50, plan Business Standard
 * → Business Starter, both written to the lead. And then nothing priced it.
 *
 * That is backwards. A reply from somebody already in conversation, naming a seat count and
 * a plan, is the MOST quote-worthy mail this app receives — a first enquiry is usually
 * vaguer. Copying the block into the append branch would have left two versions of money
 * arithmetic to keep in step, so it moved here and both branches call it.
 *
 * ─── WHAT IT DOES NOT DECIDE ────────────────────────────────────────────────
 * Whether a reply DESERVES a new quote at all — that is `shouldRequoteOnReply`, and only
 * the append branch asks it, because a brand-new lead has nothing to compare against. The
 * split matters: without that gate a five-message thread about the same fifty seats would
 * mint five GST documents, each taking an irreversible number from the gapless Rule 46
 * series.
 */
import type { createAdminClient } from "@/lib/supabase/server";
import { isEmailConfigured } from "@/lib/email/send";
import { planQuoteFromEnquiry, type CatalogueItemPrice } from "./quote-from-enquiry";
import { decideAutoSend } from "./auto-send-quote";
import { sendAutoQuote } from "./send-auto-quote";

/* Typed as the RETURN of createAdminClient — hand-rolling this shape is what produced the
   TS2589 "excessively deep" failure in lib/email/owner-alert.ts. */
type Admin = ReturnType<typeof createAdminClient>;

export interface AutoQuoteArgs {
  tenantId: string;
  leadId: string;
  /** Company name for the quote's customer_name. */
  company: string;
  /** The catalogue row the mail named, with prices. Null when nothing matched. */
  item: CatalogueItemPrice | null;
  seats: number | null;
  /** From extractEntities().term — null when the sender never said. */
  term: "monthly" | "annual" | null;
  /** What the extractor matched, quoted on the draft so a reader can check it. */
  seatsSource: string | null;
  productSource: string | null;
  termSource: string | null;
  /** Where the mail came from, and where a quote would go. */
  recipient: string;
  senderIsOurs: boolean;
  isSelfTest: boolean;
  fromEmail: string;
  /** Prefix for the draft's notes — lets the append branch say why it re-quoted. */
  notePrefix?: string;
}

export async function autoQuoteForLead(admin: Admin, args: AutoQuoteArgs): Promise<void> {
  const plan = planQuoteFromEnquiry({ item: args.item, seats: args.seats, term: args.term });

  if (!plan.ok) {
    /* Four of the planner's five outcomes are refusals, each with a reason, so a lead that
       could not be quoted says WHY on its own timeline instead of looking neglected. */
    await admin.from("lead_activities").insert({
      tenant_id: args.tenantId, lead_id: args.leadId, kind: "note",
      detail: `No quote drafted automatically — ${plan.reason}`,
    });
    return;
  }

  const today   = new Date();
  const expires = new Date(today);
  expires.setDate(expires.getDate() + 7);

  let draftQuoteId: string | null = null;
  /* Three attempts, matching the form path. `next_document_number` is the sole allocator
     (CLAUDE.md §17a) and a collision means counter drift from older seed data, not a logic
     error — the next number is the fix. */
  for (let attempt = 1; attempt <= 3 && !draftQuoteId; attempt++) {
    const { data: quoteId, error: numErr } = await admin
      .rpc("next_document_number", { p_doc_type: "quote", p_tenant_id: args.tenantId });
    if (numErr || !quoteId) {
      console.error(`[auto-quote] next_document_number attempt ${attempt} failed:`, numErr);
      break;
    }
    const { error: quoteErr } = await admin.from("quotes").insert({
      id:            quoteId as string,
      tenant_id:     args.tenantId,
      customer_id:   null,
      customer_name: args.company,
      lead_id:       args.leadId,
      plan:          args.item?.name ?? null,
      seats:         args.seats,
      line_items:    plan.items,
      subtotal:      plan.subtotal,
      total_cost:    plan.items.reduce((s, i) => s + i.qty * i.cost, 0),
      discount_pct:  0,
      tax_rate:      18,
      amount:        plan.amount,
      status:        "draft",
      owner_id:      null,
      created_date:  today.toISOString().slice(0, 10),
      expires_date:  expires.toISOString().slice(0, 10),
      /* The assumption in words on the document itself. Whoever opens this draft must READ
         "term assumed annual" rather than work it out from the rate. */
      notes:
        `${args.notePrefix ? `${args.notePrefix}\n` : ""}` +
        `Auto-drafted from an inbound email from ${args.recipient}.\n` +
        `Read from the mail: ${args.seatsSource ?? "seats unknown"} · ` +
        `${args.productSource ?? "product unknown"} · ` +
        `${args.termSource ? `term "${args.termSource}"` : "term not stated"}\n` +
        `${plan.assumption}`,
    });
    if (!quoteErr) { draftQuoteId = quoteId as string; break; }
    if (quoteErr.code === "23505") {
      console.warn(`[auto-quote] quote id collision on attempt ${attempt}: ${quoteId}`);
      continue;
    }
    console.error("[auto-quote] quote insert failed:", quoteErr);
    break;
  }

  await admin.from("lead_activities").insert({
    tenant_id: args.tenantId, lead_id: args.leadId, kind: draftQuoteId ? "quote" : "note",
    detail: draftQuoteId
      ? `Draft quote ${draftQuoteId} auto-created — ${args.seats} × ${args.item?.name}. ` +
        `${plan.termAssumed ? "Term ASSUMED annual" : `Term ${args.term} as stated`}.`
      : `Could not create the draft quote — the lead and the mail are saved, build it by hand`,
  });

  /* Send only when the customer named the term. Pardeep's rule, chosen from four options
     with the cost of each stated: monthly and annual differ by 12×, and a price the app
     inferred and posted is one the customer can reasonably hold us to.

     The gate is `termAssumed`, computed once by the planner — not a second keyword search
     here. decideAutoSend owns the other four refusals so each reaches the operator as a
     sentence rather than as silence. */
  const sendDecision = decideAutoSend({
    termAssumed:     plan.termAssumed,
    recipient:       args.recipient,
    quoteId:         draftQuoteId,
    emailConfigured: isEmailConfigured(),
    senderIsOurs:    args.senderIsOurs,
    isSelfTest:      args.isSelfTest,
  });

  if (!sendDecision.send) {
    await admin.from("lead_activities").insert({
      tenant_id: args.tenantId, lead_id: args.leadId, kind: "note",
      detail: `Quote not sent automatically — ${sendDecision.reason}`,
    });
    return;
  }

  if (!draftQuoteId) return;

  /* NOT awaited by the caller's caller: rendering a PDF inside a webhook a provider is
     waiting on would trade ingest reliability for latency. Awaited HERE so the activity rows
     above land before the send's own rows, keeping the timeline in order. */
  await sendAutoQuote(admin, {
    tenantId:  args.tenantId,
    quoteId:   draftQuoteId,
    leadId:    args.leadId,
    recipient: args.recipient,
    fromEmail: args.fromEmail,
  });
}
