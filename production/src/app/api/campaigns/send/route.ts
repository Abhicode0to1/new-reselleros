/**
 * POST /api/campaigns/send
 *
 * Bulk email campaign to leads. Audience filtered by stage / source /
 * search. Each recipient gets a personalized email with template
 * substitutions ({{name}}, {{company}}, {{offer_code}}, {{discount}},
 * {{expires}}).
 *
 * Idempotent per (campaign, recipient): each campaign_sends row has a
 * UNIQUE constraint, so re-running won't duplicate.
 *
 * Body:
 *   {
 *     name, subject, body,
 *     audience: { stages?: string[]; sources?: string[]; search?: string },
 *     offer?: { code: string; discount_pct: number; expires_at: string }
 *   }
 *
 * Returns:
 *   { campaignId, recipientsCount, sentCount, failedCount, mode }
 */

import { NextResponse, type NextRequest } from "next/server";
import { replyToAddress } from "@/lib/email/reply-to";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { sendEmail, isEmailConfigured } from "@/lib/email/send";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  name:      z.string().min(2).max(120),
  subject:   z.string().min(2).max(200),
  body:      z.string().min(10).max(20000),
  body_html: z.string().max(200000).optional(),       // optional HTML version
  audience: z.object({
    stages:  z.array(z.string()).optional(),
    sources: z.array(z.string()).optional(),
    search:  z.string().optional(),
  }).default({}),
  // Explicit, hand-picked recipients (e.g. from the Contacts page selection).
  // When present, this OVERRIDES the audience filter.
  recipients: z.array(z.object({
    email:   z.string().email(),
    name:    z.string().optional(),
    company: z.string().optional(),
  })).max(2000).optional(),
  offer: z.object({
    code:         z.string().min(1).max(50),
    discount_pct: z.coerce.number().min(0).max(100),
    expires_at:   z.string().min(10),
  }).optional(),
});

function applyTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

export async function POST(req: NextRequest) {
  // Authn
  const userClient = createClient();
  const { data: authData } = await userClient.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data: me } = await userClient
    .from("users")
    .select("tenant_id, full_name, email")
    .eq("id", authData.user.id)
    .single();
  if (!me?.tenant_id) {
    return NextResponse.json({ error: "user not linked to a tenant" }, { status: 403 });
  }

  // Parse body
  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body: " + parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  const { name, subject, body: bodyTemplate, body_html: htmlTemplate, audience, offer, recipients: explicitRecipients } = parsed.data;
  const admin = createAdminClient();

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // ── 1. Resolve recipients ─────────────────────────────────────
  // Two modes: an explicit hand-picked list (Contacts page), or the audience
  // filter over leads. Normalise both to { lead_id, contact_name, contact_email, company }.
  type Recipient = { lead_id: string | null; contact_name: string | null; contact_email: string; company: string | null };
  let recipients: Recipient[];

  if (explicitRecipients && explicitRecipients.length > 0) {
    // Dedupe by email; keep only valid addresses.
    const seen = new Set<string>();
    recipients = [];
    for (const r of explicitRecipients) {
      const email = r.email.trim().toLowerCase();
      if (!emailRe.test(email) || seen.has(email)) continue;
      seen.add(email);
      recipients.push({ lead_id: null, contact_name: r.name ?? null, contact_email: r.email.trim(), company: r.company ?? null });
    }
  } else {
    let leadsQuery = admin
      .from("leads")
      .select("id, contact_name, contact_email, company, stage, source")
      .eq("tenant_id", me.tenant_id)
      .not("contact_email", "is", null);

    if (audience.stages && audience.stages.length > 0) {
      leadsQuery = leadsQuery.in("stage", audience.stages as ("new"|"contact"|"demo"|"trial"|"quote"|"won"|"lost")[]);
    }
    if (audience.sources && audience.sources.length > 0) {
      leadsQuery = leadsQuery.in("source", audience.sources);
    }
    if (audience.search && audience.search.trim()) {
      const q = audience.search.trim();
      leadsQuery = leadsQuery.or(`company.ilike.%${q}%,contact_name.ilike.%${q}%`);
    }

    const { data: leads, error: leadsErr } = await leadsQuery;
    if (leadsErr) {
      return NextResponse.json({ error: leadsErr.message }, { status: 500 });
    }
    recipients = (leads ?? [])
      .filter((l) => l.contact_email && emailRe.test(l.contact_email))
      .map((l) => ({ lead_id: l.id, contact_name: l.contact_name, contact_email: l.contact_email!, company: l.company }));
  }

  if (recipients.length === 0) {
    return NextResponse.json(
      { error: "No recipients with a valid email — adjust the selection or filter" },
      { status: 400 }
    );
  }

  // ── 2. Tenant brand info for signature ────────────────────────
  const { data: tenant } = await admin
    .from("tenants")
    .select("name, email, phone")
    .eq("id", me.tenant_id)
    .single();
  /* Wo mailbox jise app PADHTI hai. Reply-To wahi hona chahiye — 31 Aug 2026 ko
     tenants.email par bheja gaya jawab kisi ko dikha hi nahi. lib/email/reply-to.ts. */
  const { data: ingestBoxes } = await admin
    .from("user_google_tokens").select("google_email").eq("tenant_id", me.tenant_id);

  const senderName = tenant?.name ?? "Your team";

  // ── 3. Allocate campaign ID + insert campaign row ─────────────
  const { data: campaignIdRaw, error: numErr } = await admin
    .rpc("next_document_number", { p_doc_type: "campaign", p_tenant_id: me.tenant_id });
  if (numErr || !campaignIdRaw) {
    return NextResponse.json({ error: "Could not allocate campaign number" }, { status: 500 });
  }
  const campaignId = campaignIdRaw as unknown as string;

  const { error: insertErr } = await admin.from("campaigns").insert({
    id:                 campaignId,
    tenant_id:          me.tenant_id,
    name,
    subject,
    body:               bodyTemplate,
    body_html:          htmlTemplate ?? null,
    audience_filter:    audience,
    offer_code:         offer?.code ?? null,
    offer_discount_pct: offer?.discount_pct ?? null,
    offer_expires_at:   offer?.expires_at ?? null,
    recipients_count:   recipients.length,
    sent_count:         0,
    failed_count:       0,
    status:             "sending",
    created_by:         authData.user.id,
  });
  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // ── 4. Per-recipient dispatch loop ────────────────────────────
  const fromAddress = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
  const emailMode   = isEmailConfigured() ? "real" : "stub";

  const offerExpiresFmt = offer?.expires_at
    ? new Date(offer.expires_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : "";

  let sent   = 0;
  let failed = 0;

  for (const r of recipients) {
    const firstName = (r.contact_name ?? "").split(" ")[0] || "there";
    const vars = {
      name:       firstName,
      company:    r.company || "",
      offer_code: offer?.code ?? "",
      discount:   offer ? String(offer.discount_pct) : "",
      expires:    offerExpiresFmt,
      sender:     senderName,
    };

    const renderedBody    = applyTemplate(bodyTemplate, vars);
    const renderedSubject = applyTemplate(subject,      vars);
    const renderedHtml    = htmlTemplate ? applyTemplate(htmlTemplate, vars) : undefined;

    let sendStatus: "sent" | "failed" | "stubbed" = "sent";
    let providerId: string | null = null;
    let errorMessage: string | null = null;

    try {
      const result = await sendEmail({
        to:      r.contact_email,
        from:    fromAddress,
        replyTo: replyToAddress(ingestBoxes, tenant?.email),
    route:   { tenantId: me.tenant_id },
        subject: renderedSubject,
        text:    renderedBody,
        html:    renderedHtml,
      });
      if (result.status === "failed") {
        sendStatus = "failed";
        errorMessage = result.errorMessage ?? "Unknown failure";
        failed++;
      } else if (result.status === "stubbed") {
        sendStatus = "stubbed";
        providerId = result.providerId ?? null;
        sent++;
      } else {
        sendStatus = "sent";
        providerId = result.providerId ?? null;
        sent++;
      }
    } catch (e) {
      sendStatus = "failed";
      errorMessage = e instanceof Error ? e.message : String(e);
      failed++;
    }

    await admin.from("campaign_sends").insert({
      tenant_id:       me.tenant_id,
      campaign_id:     campaignId,
      lead_id:         r.lead_id,
      recipient_email: r.contact_email,
      recipient_name:  r.contact_name,
      status:          sendStatus,
      provider_id:     providerId,
      error_message:   errorMessage,
      sent_at:         sendStatus === "failed" ? null : new Date().toISOString(),
    });
  }

  // ── 5. Finalize campaign status ───────────────────────────────
  const finalStatus = failed === recipients.length
    ? "failed"
    : "sent";

  await admin
    .from("campaigns")
    .update({
      status:       finalStatus,
      sent_count:   sent,
      failed_count: failed,
      sent_at:      new Date().toISOString(),
    })
    .eq("id", campaignId);

  return NextResponse.json({
    campaignId,
    recipientsCount: recipients.length,
    sentCount:       sent,
    failedCount:     failed,
    mode:            emailMode,
    status:          finalStatus,
  });
}
