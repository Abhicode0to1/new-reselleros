/**
 * POST /api/webhooks/inbound-email
 *
 * Inbound-email → Lead pipeline. A forwarded product-enquiry email lands here
 * (via an inbound-parse provider — Cloudflare Email Routing / Postmark /
 * SendGrid / Mailgun — that the operator forwards Gmail enquiries to), and we:
 *
 *   1. Verify the shared secret (INBOUND_EMAIL_SECRET) — fail closed.
 *   2. Normalise provider payload → { fromEmail, fromName, subject, text, messageId }.
 *   3. Claim the messageId in `inbound_emails` (UNIQUE) → idempotent (no dup leads).
 *   4. Gemini extracts { isEnquiry, company, contactName, phone, product, summary }
 *      (stub fallback when GEMINI_API_KEY is absent).
 *   5. A reply from somebody who already has an OPEN lead is filed on that
 *      conversation and is NEVER classified — the classifier is for strangers.
 *      Only when nobody matches: enquiry → create a Lead, non-enquiry → Spam /
 *      System. That ORDER is load-bearing; see lib/inbound/disposition.ts for the
 *      bug it fixes.
 *   6. Notify the reseller owner (best-effort email).
 *
 * Public route — the secret is the only guard (mirrors the Razorpay webhook's
 * fail-closed posture). Uses the admin client (no session). v1 routes leads to
 * the single buy-page tenant; multi-tenant maps the ingest address → tenant later.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveGeminiConfig } from "@/lib/ai/gemini";
import { sendEmail } from "@/lib/email/send";
import { decideFollowUp, type FollowUpInput } from "@/lib/inbound/follow-up";
import { decideInboundRoute, newTicketId } from "@/lib/inbound/routing";
import { decideDisposition } from "@/lib/inbound/disposition";
import { extractAttachments, pickBillAttachment } from "@/lib/inbound/attachments";
import { readBillWithGemini } from "@/lib/ai/read-bill";
import { sanitizeExtractedBill } from "@/app/api/ai/extract-bill/sanitize";
import type { SupabaseClient } from "@supabase/supabase-js";

const INBOUND_SECRET = process.env.INBOUND_EMAIL_SECRET?.trim() || "";
const FROM_EMAIL     = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const APP_URL        = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://resellersos.web.app";
const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";
// Which tenant inbound enquiry-emails belong to. Defaults to the buy-page
// tenant, but set INBOUND_EMAIL_TENANT_ID to route a specific reseller's
// forwarded Gmail enquiries to their own tenant (e.g. Anutech) without
// disturbing the public buy-page routing.
const INBOUND_TENANT_ID =
  process.env.INBOUND_EMAIL_TENANT_ID?.trim() || BUY_PAGE_TENANT_ID;

interface ExtractedLead {
  isEnquiry: boolean;
  company: string;
  contactName: string;
  phone: string;
  product: string;
  summary: string;
}

/** Parse "Display Name <a@b.com>" → { name, email }. Falls back gracefully. */
function parseFrom(raw: string): { name: string; email: string } {
  const s = (raw ?? "").trim();
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  // Bare email or empty
  const email = /@/.test(s) ? s.toLowerCase() : "";
  return { name: "", email };
}

/** Ask Gemini to classify + extract. Returns null on any failure (caller stubs). */
async function extractWithGemini(apiKey: string, model: string, subject: string, from: string, body: string): Promise<ExtractedLead | null> {
  const system =
    "You triage forwarded B2B emails for a cloud-software reseller (Google Workspace, " +
    "Microsoft 365, Zoho). Decide if the email is a GENUINE sales/product enquiry from a " +
    "prospective customer (NOT a newsletter, receipt, notification, OTP, spam, or internal note). " +
    "Extract the prospect's details. Return ONLY a JSON object: " +
    `{"isEnquiry":boolean,"company":string,"contactName":string,"phone":string,"product":string,"summary":string}. ` +
    "company/contactName/phone/product = empty string if unknown. summary = one short line of what they want.";
  const user = `SUBJECT: ${subject}\nFROM: ${from}\n\nBODY:\n${body.slice(0, 4000)}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
        }),
      },
    );
    if (!res.ok) {
      console.error("[inbound-email] Gemini failed:", res.status, await res.text().catch(() => ""));
      return null;
    }
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const p = JSON.parse(cleaned) as Partial<ExtractedLead>;
    return {
      isEnquiry:   p.isEnquiry === true,
      company:     (p.company ?? "").toString().trim(),
      contactName: (p.contactName ?? "").toString().trim(),
      phone:       (p.phone ?? "").toString().trim(),
      product:     (p.product ?? "").toString().trim(),
      summary:     (p.summary ?? "").toString().trim(),
    };
  } catch (err) {
    console.error("[inbound-email] Gemini crashed:", err);
    return null;
  }
}

export async function POST(request: NextRequest) {
  // ── 1. Secret guard (fail closed) ──────────────────────────────────────
  const url = new URL(request.url);
  const provided = (url.searchParams.get("key") ?? request.headers.get("x-inbound-secret") ?? "").trim();
  if (!INBOUND_SECRET || provided !== INBOUND_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── 2. Normalise payload across common inbound-parse providers ─────────
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const str = (...keys: string[]): string => {
    for (const k of keys) {
      const v = body[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };

  /**
   * Normalise headers across inbound-parse providers.
   *
   * Needed because the bulk-mail suppression in lib/inbound/follow-up.ts keys off
   * `List-Unsubscribe`, `Precedence` and `Auto-Submitted`. Without this the
   * headers arrive as undefined and that whole defence is dead code -- it would
   * look implemented and never fire once. Each provider ships a different shape:
   *
   *   Mailgun  "message-headers"  JSON (or string) array of [name, value]
   *   Postmark "Headers"          array of { Name, Value }
   *   SendGrid "headers"          one raw "Name: value" block, CRLF separated
   *
   * Keys are lower-cased; header names are case-insensitive per RFC 5322.
   */
  const extractHeaders = (): Record<string, string> => {
    const out: Record<string, string> = {};
    const put = (k: unknown, v: unknown) => {
      if (typeof k === "string" && k.trim() && typeof v === "string") {
        out[k.trim().toLowerCase()] = v.trim().slice(0, 500);
      }
    };

    let mg = body["message-headers"] ?? body["message_headers"];
    if (typeof mg === "string") { try { mg = JSON.parse(mg); } catch { mg = null; } }
    if (Array.isArray(mg)) {
      for (const pair of mg) if (Array.isArray(pair)) put(pair[0], pair[1]);
    }

    const pm = body["Headers"] ?? body["headers_json"];
    if (Array.isArray(pm)) {
      for (const h of pm) {
        const o = h as { Name?: unknown; Value?: unknown; name?: unknown; value?: unknown };
        put(o.Name ?? o.name, o.Value ?? o.value);
      }
    }

    const sg = body["headers"];
    if (typeof sg === "string") {
      for (const line of sg.split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i > 0) put(line.slice(0, i), line.slice(i + 1));
      }
    } else if (sg && typeof sg === "object" && !Array.isArray(sg)) {
      for (const [k, v] of Object.entries(sg as Record<string, unknown>)) put(k, v);
    }

    return out;
  };
  const rawHeaders = extractHeaders();

  const rawFrom   = str("from", "sender", "From", "from_email");
  /* The recipient. Every provider names it differently, and it was not being
     read at all — which is why every message became a Lead regardless of whether
     it was sent to sales@, support@ or billing@. */
  const rawTo     = str("to", "To", "recipient", "recipients", "envelope_to", "OriginalRecipient");
  const { name: parsedName, email: fromEmail } = parseFrom(rawFrom);
  const fromName  = str("fromName", "from_name", "sender_name") || parsedName;
  const subject   = str("subject", "Subject");
  const text      = str("text", "body-plain", "plain", "TextBody", "stripped-text", "body");
  const html      = str("html", "body-html", "HtmlBody", "stripped-html");
  const messageId = str("messageId", "message_id", "Message-Id", "MessageID", "Message-ID")
    || `noid-${fromEmail}-${subject}`.slice(0, 200);

  if (!fromEmail) {
    return NextResponse.json({ error: "Missing sender email" }, { status: 400 });
  }

  const admin    = createAdminClient();
  const tenantId = INBOUND_TENANT_ID;

  // ── 2b. Route on WHO IT WAS SENT TO, before anything is created ─────────
  // The address the sender chose is a fact and it is their own statement of
  // intent; the model is used inside the branch, not to pick the branch.
  const routing = decideInboundRoute(rawTo, rawFrom);
  console.log(`[inbound-email] route=${routing.route} — ${routing.reason}`);

  // ── 3. Idempotency claim — insert the message_id; UNIQUE blocks replays ─
  const { error: claimErr } = await admin.from("inbound_emails").insert({
    tenant_id:  tenantId,
    message_id: messageId,
    from_email: fromEmail,
    from_name:  fromName || null,
    to_email:   rawTo || null,
    route:      routing.route,
    subject:    subject || null,
    body_text:  text || null,
    body_html:  html || null,
    status:     "received",
  });
  if (claimErr) {
    if (claimErr.code === "23505") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    console.error("[inbound-email] claim insert failed:", claimErr);
    return NextResponse.json({ error: "Could not record email" }, { status: 500 });
  }

  const finalize = (status: string, leadId: string | null, ticketId?: string | null) =>
    admin.from("inbound_emails").update({
      status,
      lead_id: leadId,
      ...(ticketId !== undefined ? { ticket_id: ticketId } : {}),
    })
      .eq("tenant_id", tenantId).eq("message_id", messageId);

  // ── 3b. Branch on the route ────────────────────────────────────────────
  //
  // Each branch returns; only `sales` falls through to the Gemini + lead path
  // below, which is exactly what this endpoint did for EVERY message before.

  if (routing.route === "ignored") {
    // Bounce notices and auto-replies. Recorded, deliberately: "we ignored this
    // on purpose" and "we never received it" must not look the same later.
    await finalize("ignored", null);
    return NextResponse.json({ received: true, route: "ignored", reason: routing.reason });
  }

  if (routing.route === "support") {
    const ticketId = newTicketId();
    // customer_id stays null — the sender may not be a known customer, and
    // guessing one would attach a stranger's ticket to a real account. The
    // support page shows raised_by_email, so nothing is lost by not guessing.
    const { error: tErr } = await admin.from("support_tickets").insert({
      id:              ticketId,
      tenant_id:       tenantId,
      customer_id:     null,
      customer_name:   fromName || fromEmail,
      raised_by_email: fromEmail,
      raised_by_user:  null,
      category:        "other",
      // "normal", not "medium" — the enum is low|normal|high|urgent. An email
      // nobody has triaged has no claim to being urgent.
      priority:        "normal",
      subject:         subject || "(no subject)",
      body:            text || html || "(no body)",
      status:          "open",
    });
    if (tErr) {
      console.error("[inbound-email] ticket insert failed:", tErr.message);
      await finalize("error", null, null);
      // 500 so the provider retries — a support request must not be lost
      // because one insert failed.
      return NextResponse.json({ error: "Could not open a ticket" }, { status: 500 });
    }
    await finalize("ticket_created", null, ticketId);
    return NextResponse.json({ received: true, route: "support", ticketId });
  }

  if (routing.route === "billing") {
    /* Read the bill, store the original, post NOTHING to the books.
     *
     * /api/ai/extract-bill has always refused to write money from an extraction
     * — "AI can misread amounts, and this feeds GST input credit + P&L, so a
     * human must confirm". That rule matters MORE here, not less: an emailed
     * bill is less trustworthy than an uploaded one, because nobody was looking
     * when it arrived, and anyone who learns the ingest address could otherwise
     * post entries into the books. So `extracted_bill` is a suggestion and
     * `bill_id` stays null until a person reviews it. */
    const attachment = pickBillAttachment(extractAttachments(body));

    if (!attachment) {
      await finalize("billing_no_attachment", null, null);
      return NextResponse.json({
        received: true, route: "billing",
        note: "Recorded. No readable PDF or image was attached, so there was nothing to read.",
      });
    }

    // Mailgun sends a URL instead of bytes. Fetching it needs that provider's
    // credentials, which are not configured — say so plainly rather than
    // recording a success that read nothing.
    if (!attachment.base64) {
      await finalize("billing_attachment_url_only", null, null);
      return NextResponse.json({
        received: true, route: "billing", attachment: attachment.filename,
        note: "Recorded. The provider sent a link instead of the file, and fetching it is not wired.",
      });
    }

    // Keep the original. Without it the extraction cannot be checked, and an
    // audit asks for the invoice — not for what a model thought it said.
    let storedPath: string | null = null;
    try {
      const path = `${tenantId}/inbound-bills/${messageId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80)}-${attachment.filename}`;
      const { error: upErr } = await admin.storage
        .from("documents")
        .upload(path, Buffer.from(attachment.base64, "base64"), {
          contentType: attachment.mimeType, upsert: true,
        });
      if (upErr) console.error("[inbound-email] attachment upload failed:", upErr.message);
      else storedPath = path;
    } catch (e) {
      console.error("[inbound-email] attachment upload crashed:", (e as Error).message);
    }

    const gem = await resolveGeminiConfig(admin, tenantId);
    let extracted: unknown = null;
    if (gem.apiKey) {
      const ai = await readBillWithGemini({
        apiKey: gem.apiKey, model: gem.model,
        mimeType: attachment.mimeType, base64: attachment.base64,
      });
      if (ai) extracted = sanitizeExtractedBill(ai);
    }

    await admin.from("inbound_emails").update({
      status:          extracted ? "bill_extracted" : "billing_unread",
      attachment_path: storedPath,
      attachment_name: attachment.filename,
      attachment_mime: attachment.mimeType,
      extracted_bill:  (extracted as never) ?? null,
    }).eq("tenant_id", tenantId).eq("message_id", messageId);

    return NextResponse.json({
      received: true, route: "billing",
      attachment: attachment.filename,
      stored: Boolean(storedPath),
      extracted: Boolean(extracted),
      note: extracted
        ? "Read and saved as a suggestion. No vendor bill was created — a person must review the figures first."
        : gem.apiKey
          ? "Attachment stored, but the bill could not be read. Review it by hand."
          : "Attachment stored. No Gemini key is configured, so nothing was read.",
    });
  }

  /**
   * Create a follow-up task for an email that earns one.
   *
   * IDEMPOTENT BY DESIGN. A thread with five replies must produce one task, not
   * five — a task list that duplicates itself is one nobody trusts. So an
   * existing OPEN follow-up on the same lead wins: its due date is pulled
   * forward if the new email is more urgent, and nothing new is inserted.
   *
   * Best-effort throughout. This runs after the lead is already saved, so a
   * failure here must never turn a captured lead into a 500 and a webhook retry.
   */
  const createFollowUpTask = async (
    db: SupabaseClient,
    leadId: string,
    ownerId: string | null,
    signals: FollowUpInput,
  ): Promise<void> => {
    try {
      const d = decideFollowUp(signals);
      if (!d.create) {
        console.log(`[inbound-email] no follow-up task: ${d.suppressedBy} — ${d.reason}`);
        return;
      }

      const dueAt = new Date(Date.now() + d.dueInHours * 3_600_000).toISOString();

      const { data: open } = await db
        .from("tasks")
        .select("id, due_at")
        .eq("tenant_id", tenantId)
        .eq("lead_id", leadId)
        .eq("status", "pending")
        .order("due_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (open) {
        // Only ever pull the date FORWARD. Pushing it back would let a chatty
        // low-signal reply delay a follow-up that was already urgent.
        if (open.due_at && dueAt < open.due_at) {
          await db.from("tasks").update({ due_at: dueAt }).eq("id", open.id);
        }
        return;
      }

      await db.from("tasks").insert({
        tenant_id: tenantId,
        lead_id:   leadId,
        owner_id:  ownerId,          // null lands in the unassigned bucket (0007)
        title:     d.title,
        notes:     d.reason,
        kind:      "followup",
        due_at:    dueAt,
        status:    "pending",
      });
    } catch (e) {
      console.error("[inbound-email] follow-up task failed:", e);
    }
  };

  // ── 4. Extract + classify (Gemini, or stub fallback) ───────────────────
  const gemini = await resolveGeminiConfig(admin, tenantId);
  const ai = gemini.apiKey ? await extractWithGemini(gemini.apiKey, gemini.model, subject, rawFrom, text) : null;
  const extracted: ExtractedLead = ai ?? {
    isEnquiry:   true, // no AI → don't silently drop; let the operator triage
    company:     fromEmail.split("@")[1]?.split(".")[0] || fromName || "Email lead",
    contactName: fromName,
    phone:       "",
    product:     "",
    summary:     subject || "Email enquiry",
  };

  /* ── Who is this from, before deciding what it is ──────────────────────────
     This lookup used to sit BELOW the `isEnquiry` gate, and that ordering was the
     bug reported on 22 Aug 2026 as "message aaya, show nahi ho raha". A mid-thread
     reply — "actually I need 20 users of Standard, not 50 of Starter" — was handed
     to Gemini, asked "is this a sales enquiry?", correctly answered no, and filed as
     `skipped_non_enquiry`, which folders.ts puts under Spam / System. The most
     important message in the thread went to Spam, and nothing on screen said why.

     A message from somebody we are already talking to is never spam: we know who
     they are and what it is about, so there is nothing to classify. The classifier
     is for STRANGERS, which is the only case where the question is open. */
  const { data: existing } = await admin
    .from("leads")
    .select("id, notes, owner_id")
    .eq("tenant_id", tenantId)
    .ilike("contact_email", fromEmail)
    .not("stage", "in", "(won,lost)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const disposition = decideDisposition({
    openLeadId: existing?.id ?? null,
    /* `ai` is null when Gemini did not run. Passing extracted.isEnquiry here would
       pass the webhook's default-TRUE fallback and hide that distinction — and the
       difference between "the model said no" and "the model never answered" is the
       difference between spam and an untriaged customer email. */
    isEnquiry: ai ? ai.isEnquiry : null,
  });

  if (disposition.action === "skip") {
    console.info(`[webhooks/inbound-email] skipping ${fromEmail}: ${disposition.reason}`);
    await finalize("skipped_non_enquiry", null);
    return NextResponse.json({ received: true, skipped: "non_enquiry", reason: disposition.reason });
  }

  const company = extracted.company || fromName || (fromEmail.split("@")[1]?.split(".")[0]) || "Email lead";
  const note    = [
    `Inbound email lead (auto-captured).`,
    `From: ${fromName ? `${fromName} ` : ""}<${fromEmail}>`,
    subject ? `Subject: ${subject}` : null,
    extracted.summary ? `Summary: ${extracted.summary}` : null,
    text ? `\n--- original ---\n${text.slice(0, 1000)}` : null,
  ].filter(Boolean).join("\n");

  // ── 5. Append to the open lead this sender already has ────────────────────
  //     The lookup itself moved above the classifier gate — see the comment there.
  if (disposition.action === "append" && existing) {
    await admin.from("leads").update({
      notes: `${existing.notes ? existing.notes + "\n\n" : ""}[New email ${new Date().toISOString().slice(0, 10)}] ${subject || extracted.summary}`,
    }).eq("id", existing.id);
    // Log on the lead's activity timeline (visible in the drawer).
    await admin.from("lead_activities").insert({
      tenant_id: tenantId, lead_id: existing.id, kind: "email_in",
      detail: `Reply from ${fromEmail}${subject ? ` · ${subject}` : ""}`,
    });
    // A reply on a live deal is the case a follow-up task matters most for --
    // someone is mid-conversation and waiting.
    await createFollowUpTask(admin, existing.id, existing.owner_id ?? null, {
      fromEmail, subject, bodyText: text,
      // `ai` is null when Gemini did not run. Passing `extracted.isEnquiry`
      // here would pass the webhook's default-true fallback and let an
      // unclassified email create a task on an unchecked guess.
      isEnquiry: ai ? ai.isEnquiry : null,
      summary: extracted.summary,
      headers: rawHeaders,
      isReplyToExistingLead: true,
    });
    await finalize("appended_to_lead", existing.id);
    return NextResponse.json({ received: true, appendedToLead: existing.id });
  }

  // ── 6. Create the lead ─────────────────────────────────────────────────
  const leadId = "L-" + Date.now().toString(36).toUpperCase();
  const { error: leadErr } = await admin.from("leads").insert({
    id:            leadId,
    tenant_id:     tenantId,
    company,
    contact_name:  extracted.contactName || null,
    contact_email: fromEmail,
    contact_phone: extracted.phone || null,
    plan:          extracted.product || null,
    stage:         "new",
    source:        "email-inbound",
    priority:      "medium",
    notes:         note,
  });
  if (leadErr) {
    console.error("[inbound-email] lead insert failed:", leadErr);
    await finalize("error", null);
    return NextResponse.json({ error: "Could not create lead" }, { status: 500 });
  }
  await finalize("lead_created", leadId);
  await admin.from("lead_activities").insert({
    tenant_id: tenantId, lead_id: leadId, kind: "email_in",
    detail: `Email from ${fromEmail}${subject ? ` · ${subject}` : ""}`,
  });
  // owner_id is null on a freshly captured email lead, so the task lands in the
  // unassigned bucket for the owner to hand out -- which is what 0007 designed
  // that bucket for.
  await createFollowUpTask(admin, leadId, null, {
    fromEmail, subject, bodyText: text,
    isEnquiry: ai ? ai.isEnquiry : null,
    summary: extracted.summary,
    headers: rawHeaders,
    isReplyToExistingLead: false,
  });

  // ── 7. Notify the reseller owner (best-effort) ─────────────────────────
  const { data: tenant } = await admin.from("tenants").select("email, name").eq("id", tenantId).maybeSingle();
  const ownerEmail = tenant?.email?.trim();
  if (ownerEmail) {
    void sendEmail({
      to:      ownerEmail,
      from:    FROM_EMAIL,
      replyTo: fromEmail,
      subject: `🔔 New email lead — ${company}`,
      text:
`A product enquiry email was auto-captured as a lead.

COMPANY   ${company}
CONTACT   ${extracted.contactName || "—"} <${fromEmail}>
PHONE     ${extracted.phone || "—"}
PRODUCT   ${extracted.product || "—"}
SUBJECT   ${subject || "—"}
SUMMARY   ${extracted.summary || "—"}

Open the lead: ${APP_URL}/leads
— ResellerOS`,
    }).catch((e) => console.error("[inbound-email] notify failed:", e));
  }

  return NextResponse.json({ received: true, leadId });
}
