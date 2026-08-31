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
import type { BillingCycle } from "@/lib/supabase/database.types";

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
  /** True when the seat count came out of a voice-note transcription, not the customer. */
  heardNotWritten?: boolean;
  productSource: string | null;
  termSource: string | null;
  /** Where the mail came from, and where a quote would go. */
  recipient: string;
  senderIsOurs: boolean;
  isSelfTest: boolean;
  fromEmail: string;
  /** Prefix for the draft's notes — lets the append branch say why it re-quoted. */
  notePrefix?: string;
  /**
   * Re-price THIS existing draft instead of taking a new document number.
   *
   * From `shouldRequoteOnReply`, and only ever a `draft`. Pardeep's decision, 31 Aug 2026:
   * Q-ADPL-2026-27-0055 was drafted on an assumed annual term, correctly not sent, and the
   * agent had already told the customer its number. When the customer supplied the term, the
   * right document was that one at the right price — not a second number with the first left
   * dead in the gapless Rule 46 series.
   *
   * The UPDATE is scoped by tenant, lead AND `status = 'draft'`, so a quote that was sent in
   * the meantime cannot be rewritten underneath the customer. If it matches nothing, this
   * falls through to allocating a new number and says so on the timeline.
   */
  repriceDraftId?: string;
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

  /* The money fields, computed once. Written by the INSERT below and, when an unsent draft is
     being corrected, by the UPDATE above it — one object so the two paths cannot price the
     same quote differently. */
  const priced = {
    plan:          args.item?.name ?? null,
    seats:         args.seats,
    line_items:    plan.items,
    subtotal:      plan.subtotal,
    /* `as const` zaroori hai: object literal me ternary `string` par widen ho jata hai,
       aur column ek union hai. */
    billing_cycle: (plan.items[0]?.commitment === "monthly" ? "monthly" : "yearly") as BillingCycle,
    total_cost:    plan.items.reduce((sum, i) => sum + i.qty * i.cost, 0),
    discount_pct:  plan.discountPct,
    tax_rate:      18,
    amount:        plan.amount,
  };

  /* The assumption in words on the document itself. Whoever opens this draft must READ "term
     assumed annual" rather than work it out from the rate.
     Hoisted so a RE-PRICED draft gets the same sentence: a corrected quote still carrying
     "term not stated" would be the document lying about itself. */
  const noteText =
    `${args.notePrefix ? `${args.notePrefix}\n` : ""}` +
    `Auto-drafted from an inbound email from ${args.recipient}.\n` +
    `Read from the mail: ${args.seatsSource ?? "seats unknown"} · ` +
    `${args.productSource ?? "product unknown"} · ` +
    `${args.termSource ? `term "${args.termSource}"` : "term not stated"}\n` +
    `${plan.assumption}`;

  let draftQuoteId: string | null = null;
  let repriced = false;

  /* ── CORRECT THE UNSENT DRAFT, DO NOT REPLACE IT ──────────────────────────────
     `status = "draft"` is in the filter, not in a comment: it is what makes this safe. A
     quote that was sent between the decision and this write matches nothing, and the code
     falls through to a new number rather than rewriting a document the customer is holding. */
  if (args.repriceDraftId) {
    const { data: updated, error: upErr } = await admin
      .from("quotes")
      .update({ ...priced, notes: noteText })
      .eq("id", args.repriceDraftId)
      .eq("tenant_id", args.tenantId)
      .eq("lead_id", args.leadId)
      .eq("status", "draft")
      .select("id")
      .maybeSingle();

    if (upErr) {
      console.error("[auto-quote] reprice failed:", upErr);
    } else if (updated?.id) {
      draftQuoteId = updated.id as string;
      repriced = true;
    } else {
      /* Said out loud. "The number you were promised is not the number you got" is exactly
         the kind of thing that must never be inferred from silence. */
      await admin.from("lead_activities").insert({
        tenant_id: args.tenantId, lead_id: args.leadId, kind: "note",
        detail:
          `${args.repriceDraftId} could not be re-priced — it is no longer an unsent draft. ` +
          "Raising a new quotation instead.",
      });
    }
  }

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
      /* Every money field comes from `priced`, the SAME object the re-price UPDATE writes.
         Two lists would be two chances to price one quote differently. */
      ...priced,
      /* ── THE COLUMN THE PDF BELIEVES, AND IT WAS NEVER SET ────────────────
         This insert did not name `billing_cycle` at all, so every auto-quote took the
         column default — `yearly` — however the line was priced.

         Harmless while everything was quoted annually. The moment a monthly quote could be
         raised (30 Aug 2026), it became a 12× error on a GST document: QuotePDF resolves
         `billingCycle ?? cycleFromLegacyCommitment(firstCommitment)`, so the ROW wins over
         the LINE. Q-ADPL-2026-27-0049, sent to a customer:

           line   45 x Rs 325/seat/MONTH  ->  subtotal Rs 14,625  (correct, monthly)
           row    billing_cycle "yearly"
           PDF    Rs 27/seat/mo, Rs 1,219/mo, "Annual contract value Rs 16,739"

         Rs 14,625 read as a year and divided by twelve. The true annual value is
         Rs 1,75,500. The words on the document even said "Monthly (flex), billed monthly"
         while the arithmetic said otherwise — the line and the row disagreed, and the row
         is the one the renderer trusts.

         `plan.items[0].commitment` is what the planner actually priced, so this is that
         same fact rather than a second reading of the customer's words.

         All of that now lives in `priced`, at the top of this function — including
         `discount_pct`, which comes from the volume rate card and must NOT also be inside the
         line rate, because every screen renders it as its own "Discount (n%)" row off the
         subtotal. */
      status:        "draft",
      owner_id:      null,
      created_date:  today.toISOString().slice(0, 10),
      expires_date:  expires.toISOString().slice(0, 10),
      notes:         noteText,
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
      ? `${repriced ? "Draft quote " + draftQuoteId + " RE-PRICED" : "Draft quote " + draftQuoteId + " auto-created"} — ${args.seats} × ${args.item?.name}. ` +
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
    /* The seat count the quote was actually priced at, so the volume review band judges the
       same number the customer would read on the document. */
    seats:           args.seats,
    recipient:       args.recipient,
    quoteId:         draftQuoteId,
    emailConfigured: isEmailConfigured(),
    seatsHeardNotWritten: args.heardNotWritten,
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
