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
    secrets?.whatsapp_app_secret,
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
