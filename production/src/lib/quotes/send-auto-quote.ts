/**
 * Emails an auto-drafted quote to the person who asked for it.
 *
 * ─── WHY THIS IS NOT `POST /api/quotes/[id]/send` ───────────────────────────
 * That route is the OPERATOR's send: it authenticates a session, resolves `me.tenant_id`
 * from it, accepts a custom message and cc list, and reads a CUSTOMER record for the GST
 * place-of-supply. The inbound webhook has none of those — no session, no cc, and no
 * customer at all, because an auto-drafted quote belongs to a lead (`customer_id` is null).
 *
 * Refactoring that 265-line route to serve both was considered and rejected on 23 Aug 2026
 * for one measured reason: it has no tests. `send-consequences.test.ts` covers a pure
 * helper beside it, nothing covers the route itself, and extracting the send stack out of
 * an untested money path is how a working feature breaks quietly. So this is a narrower
 * sender, and the narrowing is listed rather than left to be discovered:
 *
 *   - no cc, no custom message — nobody is present to write one
 *   - no UPI QR. `buildQuoteUpiQr` is worth having and is the first thing to add here, but
 *     a missing QR costs a scan-to-pay convenience, while a wrong one costs a payment
 *   - GST head is the tenant's default, because there is no customer state to compare
 *     against. Identical to what the operator route computes for a lead-quote, where
 *     `customer?.state_code` is likewise undefined — so this is the same answer, not a
 *     different one
 *
 * The DECISION to send at all is not here — see lib/quotes/auto-send-quote.ts. This runs
 * only after that said yes.
 *
 * ─── IT RECORDS EVERYTHING, INCLUDING ITS OWN FAILURES ──────────────────────
 * `quote_send_log` gets a row whatever happens, and the lead's timeline gets a line either
 * way. An automated send that fails silently is worse than one that never ran: the operator
 * sees "quote sent" in the pipeline and stops chasing.
 */
import { sendEmail } from "@/lib/email/send";
import { renderQuotePDF } from "@/lib/pdf";
import { logoDataUri } from "@/lib/pdf/logo";
import { rupee } from "@/lib/utils";
import { stageAfterQuoteSent } from "@/lib/leads/stage-after-quote-sent";
import type { createAdminClient } from "@/lib/supabase/server";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

export interface SendAutoQuoteArgs {
  tenantId: string;
  quoteId: string;
  leadId: string;
  /** Where the enquiry came from. Already validated by decideAutoSend. */
  recipient: string;
  /** Envelope sender for the deployment. */
  fromEmail: string;
}

/* Typed as the RETURN of createAdminClient rather than as a hand-rolled structural type.
   Writing the shape out by hand is what produced the TS2589 "excessively deep" failure in
   lib/email/owner-alert.ts — the fix there was exactly this, and it is cheaper to copy the
   fix than to rediscover it. */
type Admin = ReturnType<typeof createAdminClient>;

interface QuoteRow {
  id: string;
  customer_name: string | null;
  line_items: unknown;
  subtotal: number | null;
  discount_pct: number | null;
  tax_rate: number | null;
  amount: number | null;
  expires_date: string | null;
  notes: string | null;
  is_renewal: boolean | null;
  status: string | null;
}

interface TenantRow {
  name: string | null;
  email: string | null;
  phone: string | null;
  gstin: string | null;
  address: string | null;
  logo_url: string | null;
}

export async function sendAutoQuote(admin: Admin, args: SendAutoQuoteArgs): Promise<void> {
  const note = async (detail: string) => {
    await admin.from("lead_activities").insert({
      tenant_id: args.tenantId, lead_id: args.leadId, kind: "note", detail,
    });
  };

  const { data: q } = await admin
    .from("quotes")
    .select("id, customer_name, line_items, subtotal, discount_pct, tax_rate, amount, expires_date, notes, is_renewal, status")
    .eq("id", args.quoteId)
    .eq("tenant_id", args.tenantId)
    .maybeSingle();
  const quote = q as QuoteRow | null;

  if (!quote) {
    await note(`Quote ${args.quoteId} could not be re-read before sending — nothing was sent.`);
    return;
  }
  /* Re-read and re-checked rather than trusted from the caller. Between drafting and here
     the row could have been sent by hand; sending twice is a worse outcome than not
     sending, because the customer gets two prices and has to ask which one counts. */
  if (quote.status !== "draft") {
    await note(`Quote ${args.quoteId} was already ${quote.status} — not sent again.`);
    return;
  }

  const { data: t } = await admin
    .from("tenants").select("name, email, phone, gstin, address, logo_url")
    .eq("id", args.tenantId).maybeSingle();
  const tenant = (t ?? {}) as TenantRow;

  const lineItems = (Array.isArray(quote.line_items) ? quote.line_items : []) as QuoteLineItem[];
  const subtotal    = quote.subtotal ?? 0;
  const discountPct = quote.discount_pct ?? 0;
  const discount    = Math.round(subtotal * (discountPct / 100));
  const taxable     = subtotal - discount;
  const taxRate     = quote.tax_rate ?? 18;
  const tax         = Math.round(taxable * (taxRate / 100));
  /* The STORED total, not a recompute. quote.amount is what the draft committed to and what
     the operator would see in the app — a PDF that disagrees with the row by a rupee is a
     conversation nobody wants to have with a customer. */
  const total = quote.amount ?? taxable + tax;

  let attachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
  try {
    const blob = await renderQuotePDF({
      upiQrDataUrl:  null,
      upiVpa:        null,
      tenantName:    tenant.name ?? "",
      tenantGstin:   tenant.gstin,
      tenantEmail:   tenant.email,
      tenantPhone:   tenant.phone,
      tenantAddress: tenant.address,
      /* This is the quote the AI sends on its own, so it is the one a customer is most likely
         to see first. Resolved here rather than in the renderer: `logoDataUri` has a deadline
         and returns null on every failure, so a logo can cost the monogram but never the
         send — and this whole block already sits inside a try that degrades to no PDF. */
      tenantLogo:    await logoDataUri(tenant.logo_url),
      quoteId:       quote.id,
      customerName:  quote.customer_name ?? "",
      contactName:   null,
      contactEmail:  args.recipient,
      contactPhone:  null,
      lineItems,
      subtotal,
      discountPct,
      discount,
      taxable,
      taxRate,
      tax,
      total,
      /* No customer record on a lead-quote, so there is no buyer state to compare — the
         tenant's own default applies, exactly as it does on the operator route when
         `customer?.state_code` is undefined. */
      interState:    false,
      validityDays:  30,
      notes:         quote.notes ?? undefined,
      isRenewal:     quote.is_renewal ?? false,
    });
    attachments = [{
      filename:    `Quote-${quote.id}.pdf`,
      content:     Buffer.from(await blob.arrayBuffer()),
      contentType: "application/pdf",
    }];
  } catch (pdfErr) {
    /* Non-fatal, same as the operator route: the mail still carries the figure and the
       link. Logged, and said out loud on the lead, because "the customer got a quote with
       no PDF" is something the person chasing it needs to know. */
    console.warn(`[send-auto-quote] PDF render failed for ${quote.id}:`, (pdfErr as Error).message);
  }

  const seller  = tenant.name?.trim() || "Your reseller";
  const summary = lineItems
    .map((li) => `  ${li.qty} × ${li.name} — ${rupee(li.qty * li.rate)}`)
    .join("\n");

  const result = await sendEmail({
    to:      args.recipient,
    from:    args.fromEmail,
    /* Replies go to the tenant, not to the envelope sender — a customer answering this
       must reach a person. */
    replyTo: tenant.email ?? undefined,
    kind:    "auto_quote_from_email",
    route:   { tenantId: args.tenantId },
    /* Gated by the workspace kill switch + dial. This is the newest automated send in the
       app and the one carrying a price, so it is the last thing that should be exempt —
       `decideAutoSend` already checked the FACTS (did the customer state a term), and this
       checks the PERMISSION. Two different questions, both required. */
    automated: { tenantId: args.tenantId, action: "quote.send" },
    subject: `Your quote ${quote.id} — ${seller}`,
    text:
`Thanks for the enquiry. Your quote is attached and summarised below.

QUOTE ${quote.id}
${summary}

  Subtotal        ${rupee(subtotal)}${discountPct ? `\n  Discount ${discountPct}%   -${rupee(discount)}` : ""}
  GST ${taxRate}%          ${rupee(tax)}
  TOTAL           ${rupee(total)}
${quote.expires_date ? `\nValid until ${quote.expires_date}.` : ""}

Reply to this email if anything needs changing — the seat count, the plan or the billing
term — and we will send a revised quote.

— ${seller}`,
    attachments,
  });

  /* ── THE TWO WRITES BELOW ARE CHECKED NOW, AND WERE NOT ────────────────────
     Measured on the live run of 23 Aug 2026, and this file's own header promised the
     opposite: "quote_send_log gets a row whatever happens".

       email_log            → status "sent", provider gmail   (the mail really went)
       quote_send_log       → EMPTY
       quotes.status        → still "draft"
       lead_activities      → "Quote Q-…-0042 emailed automatically … (PDF attached)"

     All four at once, because the two middle writes were `await admin.from(...)` with the
     `{ error }` never read, and supabase-js does not throw — it hands back an error object
     nobody looked at. So the function sailed past both and wrote a success line. The
     pipeline shows a quote as unsent while the customer holds it, which is the exact
     failure the comment underneath claimed to prevent.

     Note what the DB says about it: both statements succeed when run by hand inside a
     rollback, so the cause is at the client and not a constraint. That is precisely why
     these are now REPORTED rather than diagnosed — an unchecked write hides its own reason,
     and the next run will name it instead of us guessing. */
  const { error: sendLogErr } = await admin.from("quote_send_log").insert({
    tenant_id:       args.tenantId,
    quote_id:        quote.id,
    recipient_email: args.recipient,
    cc_emails:       null,
    subject:         `Your quote ${quote.id} — ${seller}`,
    status:          result.status,
  });
  if (sendLogErr) {
    /* Not fatal — the mail has already gone and `email_log` records that. But an audit trail
       with a hole in it must announce the hole, or the next person reconciling sends will
       conclude the quote was never sent. */
    console.error("[send-auto-quote] quote_send_log insert failed:", sendLogErr);
    await note(
      `Quote ${quote.id} WAS emailed to ${args.recipient}, but the send could not be written ` +
      `to the audit log — ${sendLogErr.message}. The email itself is recorded in email_log.`,
    );
  }

  if (result.status === "failed") {
    await note(
      `Quote ${quote.id} could NOT be emailed to ${args.recipient} — ${result.errorMessage ?? "send failed"}. ` +
      `The draft is saved; send it by hand.`,
    );
    return;
  }

  /* Status moves only on a real send. A quote marked sent that never left would make the
     pipeline lie and stop somebody chasing it — and the inverse, which is what happened,
     leaves a sent quote sitting in the pipeline as a draft somebody will send again.

     `select("id")` so the response carries the rows it touched: an update matching NOTHING
     is a success in supabase-js, and "matched nothing" is indistinguishable from "worked"
     without asking. */
  const { data: updated, error: statusErr } = await admin
    .from("quotes")
    .update({ status: "sent" })
    .eq("id", quote.id)
    .eq("tenant_id", args.tenantId)
    .select("id");

  if (statusErr || (updated ?? []).length === 0) {
    console.error(
      `[send-auto-quote] could not mark ${quote.id} as sent:`,
      statusErr ?? "update matched no rows",
    );
    await note(
      `Quote ${quote.id} was emailed to ${args.recipient}, but it is still marked DRAFT — ` +
      `${statusErr?.message ?? "the status update matched no rows"}. Mark it sent by hand so ` +
      `nobody sends it twice.`,
    );
  }

  await admin.from("lead_activities").insert({
    tenant_id: args.tenantId, lead_id: args.leadId, kind: "email_out",
    detail:
      `Quote ${quote.id} emailed automatically to ${args.recipient} — ${rupee(total)}` +
      `${attachments ? " (PDF attached)" : " (PDF failed to render; figures in the body)"}. ` +
      `Term was stated in their mail.`,
  });

  /* ── AND MOVE THE LEAD INTO "Quote Sent" ───────────────────────────────────
     Wired here AND in api/quotes/[id]/send in the same edit, deliberately. Two of today's
     bugs were exactly this shape — a rule applied to one of its call sites and not the
     others (L75: the auto-quote wired to one webhook branch; L97: the self-test flag reaching
     two gates of three). Darshan's report is the third, and it is the same disease at the
     data layer: only the public buy-page checkout ever set `stage = "quote"`.

     Forward only. stageAfterQuoteSent refuses to drag a Won or Lost lead backwards, and its
     reason is logged either way so a lead that did NOT move is explicable. */
  const { data: leadRow } = await admin
    .from("leads")
    .select("stage")
    .eq("id", args.leadId)
    .eq("tenant_id", args.tenantId)
    .maybeSingle();

  const move = stageAfterQuoteSent((leadRow as { stage?: string | null } | null)?.stage);
  if (move.nextStage) {
    const { error: stageErr } = await admin
      .from("leads")
      .update({ stage: move.nextStage })
      .eq("id", args.leadId)
      .eq("tenant_id", args.tenantId);
    if (stageErr) {
      console.error(`[send-auto-quote] could not move lead ${args.leadId} to Quote Sent:`, stageErr);
      await note(`Quote ${quote.id} was sent but the lead did not move to Quote Sent — ${stageErr.message}. Move it by hand so the board is right.`);
    } else {
      await admin.from("lead_activities").insert({
        tenant_id: args.tenantId, lead_id: args.leadId, kind: "stage",
        detail: `Moved to Quote Sent — ${quote.id} was emailed to ${args.recipient}.`,
      });
    }
  } else {
    console.info(`[send-auto-quote] lead ${args.leadId} stage unchanged — ${move.reason}`);
  }
}
