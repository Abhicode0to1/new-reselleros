/**
 * GET  /api/webhooks/whatsapp?tenant=...  → Meta verification handshake
 * POST /api/webhooks/whatsapp?tenant=...  → inbound messages + delivery
 *                                            status updates from Meta
 *
 * Setup:
 *  1. Pardeep saves credentials in Settings → Integrations → WhatsApp
 *     (verify_token field — any random string he wants)
 *  2. He copies the webhook URL (which already has ?tenant=... appended)
 *     into Meta dashboard → WhatsApp → Configuration → Webhook
 *  3. He pastes the SAME verify_token into Meta's "Verify Token" field
 *  4. Meta sends a GET ping with hub.mode + hub.challenge — we echo the
 *     challenge back if the token matches
 *  5. Subsequent POST requests carry inbound messages + status updates
 *
 * Security:
 *  - Verify token check on GET (tenant-specific)
 *  - MANDATORY HMAC signature check on POST using whatsapp_app_secret. No
 *    secret stored → every POST is refused, because an unverified webhook is
 *    unauthenticated write access rather than a weaker check. Save the App
 *    Secret in Settings → Integrations → WhatsApp before going live.
 *  - All inbound writes use the service-role admin client (Meta is not
 *    authenticated as one of our users)
 */

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { verifyMetaSignature, signatureRefusalReason } from "@/lib/crypto/webhook-signature";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { runSalesAgentForLead } from "@/lib/ai/run-sales-agent";

/* Envelope sender + trading name for anything the AI sales agent sends off the back of a
   WhatsApp message. Mirrors the inbound-email webhook so one reseller cannot end up sending
   mail signed as another. */
const FROM_EMAIL  = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const SELLER_NAME = process.env.SELLER_LEGAL_NAME?.trim()   || "ANUTECH DIGITAL PVT LTD";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

// ──────────────────────────────────────────────────────────────────────
// GET: handshake
//   Meta calls this once when Pardeep saves the webhook in the dashboard.
//   Query params:  hub.mode=subscribe & hub.verify_token=<...> & hub.challenge=<...>
//   Expected: 200 with the challenge string as the body, OR 403 on mismatch.
// ──────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const url       = new URL(req.url);
  const tenantId  = url.searchParams.get("tenant");
  const mode      = url.searchParams.get("hub.mode");
  const token     = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (!tenantId) return NextResponse.json({ error: "missing tenant" }, { status: 400 });
  if (mode !== "subscribe" || !token || !challenge) {
    return NextResponse.json({ error: "invalid handshake" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data } = await admin
    .from("tenant_secrets")
    .select("whatsapp_verify_token")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!data?.whatsapp_verify_token) {
    return NextResponse.json({ error: "no verify token configured" }, { status: 403 });
  }
  if (data.whatsapp_verify_token !== token) {
    return NextResponse.json({ error: "verify_token mismatch" }, { status: 403 });
  }

  // Echo the challenge back as plain text — Meta needs this exact body.
  return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

// ──────────────────────────────────────────────────────────────────────
// POST: inbound messages + delivery status updates
//   Body shape (abridged):
//   { object: "whatsapp_business_account",
//     entry: [{
//       id: "<WABA-id>",
//       changes: [{
//         field: "messages",
//         value: {
//           messaging_product: "whatsapp",
//           metadata: { phone_number_id, display_phone_number },
//           contacts: [{ profile: { name }, wa_id }],
//           messages: [{
//             from, id, timestamp, type, text?: { body }, image?, ...
//           }],
//           statuses: [{
//             id, status, timestamp, recipient_id, errors?
//           }]
//         }
//       }]
//     }]
//   }
// ──────────────────────────────────────────────────────────────────────
type MetaMessage = {
  from: string; id: string; timestamp?: string; type: string;
  text?:        { body?: string };
  image?:       { id?: string; mime_type?: string; caption?: string };
  document?:    { id?: string; mime_type?: string; filename?: string; caption?: string };
  video?:       { id?: string; mime_type?: string; caption?: string };
  audio?:       { id?: string; mime_type?: string };
  sticker?:     { id?: string; mime_type?: string };
  location?:    { latitude?: number; longitude?: number; name?: string; address?: string };
  reaction?:    { message_id?: string; emoji?: string };
  button?:      { text?: string; payload?: string };
  interactive?: unknown;
};
type MetaStatus = {
  id: string; status: string; timestamp?: string; recipient_id?: string;
  errors?: Array<{ code?: number | string; title?: string; message?: string }>;
};
type MetaChangeValue = {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: MetaMessage[];
  statuses?: MetaStatus[];
};

export async function POST(req: NextRequest) {
  const url      = new URL(req.url);
  const tenantId = url.searchParams.get("tenant");
  if (!tenantId) return NextResponse.json({ error: "missing tenant" }, { status: 400 });

  const rawBody = await req.text();

  const admin = createAdminClient();

  // MANDATORY HMAC check — Meta signs with the App Secret (sha256), sent as
  // `x-hub-signature-256: sha256=<hex>` over the RAW body.
  //
  // This was conditional: `if (secrets?.whatsapp_app_secret) { ...verify... }`,
  // so a tenant with no app secret stored had NO verification at all and the
  // payload was processed. Production has no whatsapp_app_secret, which made
  // this endpoint unauthenticated remote write access — anyone with the URL and
  // a tenant id could inject inbound "messages" that the app turns into
  // contacts, conversations and lead activity.
  //
  // Now it fails closed, matching the Razorpay webhook. The cost of refusing is
  // one configuration step; the cost of allowing is whatever an attacker sends.
  const { data: secrets } = await admin
    .from("tenant_secrets")
    .select("whatsapp_app_secret")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  const verdict = verifyMetaSignature(
    rawBody,
    req.headers.get("x-hub-signature-256"),
    decryptTenantSecrets(secrets)?.whatsapp_app_secret,
  );
  if (!verdict.ok) {
    console.warn(
      `[/api/webhooks/whatsapp] refused for tenant ${tenantId} — ${signatureRefusalReason(verdict.reason)}`,
    );
    // Same body for every reason: telling a caller whether a secret exists is
    // itself information about the tenant.
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let body: { entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: MetaChangeValue }> }> };
  try { body = JSON.parse(rawBody); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  let messagesStored = 0;
  let statusesApplied = 0;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const v = change.value ?? {};

      // ── Inbound messages
      for (const m of v.messages ?? []) {
        const text =
          m.text?.body ?? m.image?.caption ?? m.video?.caption ?? m.document?.caption ?? null;
        // Map Meta's message types into ours. Anything we don't know
        // gets stored as 'unsupported' so the Inbox can still show it.
        const KNOWN: ReadonlyArray<string> = [
          "text","template","image","document","video","audio",
          "location","reaction","sticker","button","interactive",
        ];
        const type = (KNOWN.includes(m.type) ? m.type : "unsupported") as
          | "text"|"template"|"image"|"document"|"video"|"audio"
          |"location"|"reaction"|"sticker"|"button"|"interactive"|"unsupported";

        const mediaId =
          m.image?.id ?? m.document?.id ?? m.video?.id ?? m.audio?.id ?? m.sticker?.id ?? null;
        const mediaMime =
          m.image?.mime_type ?? m.document?.mime_type ?? m.video?.mime_type ?? m.audio?.mime_type ?? m.sticker?.mime_type ?? null;
        const mediaFilename = m.document?.filename ?? null;

        const tsSec = m.timestamp ? Number(m.timestamp) : null;
        const tsIso = tsSec && Number.isFinite(tsSec) ? new Date(tsSec * 1000).toISOString() : null;

        const { error: insertErr } = await admin.from("whatsapp_messages").insert({
          tenant_id:      tenantId,
          wamid:          m.id,
          contact_phone:  `+${m.from}`,
          direction:      "inbound",
          type,
          text_body:      text,
          media_id:       mediaId,
          media_mime:     mediaMime,
          media_filename: mediaFilename,
          status:         "received",
          meta_timestamp: tsIso,
        });
        // unique constraint on (tenant, wamid) — Meta retries are harmless
        if (!insertErr) messagesStored++;

        /* ── Hand it to the AI sales agent ─────────────────────────────────────
           GATED ON `!insertErr`, and that single condition is the whole idempotency
           story. Meta retries a webhook until it gets a 200, and this route always
           returns 200 — so without the gate a retried delivery would run the agent
           again and answer the same customer twice. The unique index on
           (tenant_id, wamid) is what makes the retry detectable at all: the second
           insert fails, `insertErr` is set, and the agent does not run.

           Text only. An image, a sticker or a reaction has nothing for the model to
           read, and `text` is already null for those — a reply to "👍" would be the
           app talking to itself. The message is still STORED, so the Inbox shows it
           and a person can answer.

           Not awaited, matching the inbound-email webhook: a Gemini call inside a
           request Meta is waiting on would trade ingest reliability for latency, and
           the message is committed by here. */
        if (!insertErr && type === "text" && text && text.trim()) {
          const phone = `+${m.from}`;
          const profileName = (v.contacts ?? []).find((c) => c.wa_id === m.from)?.profile?.name ?? "";
          void handleWhatsAppEnquiry(admin, tenantId, phone, profileName, text.trim())
            .catch((err) => console.error("[/api/webhooks/whatsapp] sales agent crashed:", err));
        }
      }

      // ── Delivery status updates (for messages WE sent)
      for (const st of v.statuses ?? []) {
        const ALLOWED = ["sent", "delivered", "read", "failed", "received"] as const;
        type MStatus = (typeof ALLOWED)[number];
        const newStatus: MStatus = (ALLOWED as ReadonlyArray<string>).includes(st.status)
          ? (st.status as MStatus)
          : "sent";
        const err = st.errors?.[0];
        const tsSec = st.timestamp ? Number(st.timestamp) : null;
        const tsIso = tsSec && Number.isFinite(tsSec) ? new Date(tsSec * 1000).toISOString() : null;
        await admin
          .from("whatsapp_messages")
          .update({
            status:         newStatus,
            meta_timestamp: tsIso,
            error_code:     err?.code != null ? String(err.code) : null,
            error_message:  err?.message ?? err?.title ?? null,
          })
          .eq("tenant_id", tenantId)
          .eq("wamid",     st.id);
        statusesApplied++;
      }
    }
  }

  // Meta retries until 200. Always 200 unless we want to force re-deliver.
  return NextResponse.json({ ok: true, messagesStored, statusesApplied });
}

/**
 * Find or create the lead behind a WhatsApp number, then run the AI sales agent on it.
 *
 * ─── WHY A LOOKUP BEFORE AN INSERT, AND WHY IT IS NOT AN UPSERT ─────────────
 * `leads.id` is a text id minted here, not a natural key, so there is nothing for
 * `on conflict` to match on and an upsert would silently insert a duplicate. The lookup is
 * therefore explicit: the newest non-junk lead carrying this phone number is the conversation
 * this message belongs to.
 *
 * Junk leads are excluded from the match on purpose. Somebody marked that lead junk; matching
 * a new message onto it would resurrect a rejected conversation and, worse, feed the agent a
 * transcript a human had already dismissed.
 *
 * ─── AND WHY A LEAD IS CREATED AT ALL ───────────────────────────────────────
 * A first WhatsApp message from an unknown number is exactly the enquiry this product exists
 * to capture, and every downstream piece — the transcript's composite FK, the follow-up loop,
 * the quote, the handover flag — hangs off a lead id. The cost is honest and worth stating: a
 * wrong number that texts this line becomes a lead in the pipeline. `source` marks it
 * `whatsapp-inbound` so anything reporting on real demand can tell where it came from, and the
 * agent's own junk-handling is the next line of defence rather than a filter here that would
 * also drop real enquiries.
 */
async function handleWhatsAppEnquiry(
  admin: ReturnType<typeof createAdminClient>,
  tenantId: string,
  phone: string,
  profileName: string,
  message: string,
): Promise<void> {
  const { data: existing } = await admin
    .from("leads")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("contact_phone", phone)
    .eq("is_junk", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let leadId = (existing as { id?: string } | null)?.id ?? null;

  if (!leadId) {
    /* Same id shape as the inbound-email webhook (route.ts:831). */
    const fresh = "L-" + Date.now().toString(36).toUpperCase();
    const { error } = await admin.from("leads").insert({
      id:            fresh,
      tenant_id:     tenantId,
      /* The WhatsApp profile name is a person's name, not a company — but `company` is NOT
         NULL and it is what every pipeline screen shows, so leaving it blank would render a
         nameless row. The number is the honest fallback: it is what we actually know, and it
         is what a person needs in order to ring back. */
      company:       profileName || phone,
      contact_name:  profileName || null,
      contact_email: null,
      contact_phone: phone,
      plan:          null,
      seats:         null,
      stage:         "new",
      source:        "whatsapp-inbound",
      priority:      "medium",
      notes:         `Created from an inbound WhatsApp message from ${phone}.`,
    });
    if (error) {
      console.error("[/api/webhooks/whatsapp] lead insert failed:", error);
      return;
    }
    leadId = fresh;
  }

  await runSalesAgentForLead({
    admin,
    tenantId,
    leadId,
    incoming: message,
    customerContact: phone,
    channel: "whatsapp",
    /* Meta delivers messages FROM customers on this webhook; our own sends come back as
       status updates, not messages. So an inbound message is never our own address, and there
       is no self-test marker convention on this channel yet. */
    senderIsOurs: false,
    isSelfTest:   false,
    fromEmail:    FROM_EMAIL,
    sellerName:   SELLER_NAME,
  });
}
