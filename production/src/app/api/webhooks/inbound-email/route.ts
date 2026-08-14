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
 *   5. Non-enquiry → skip. Enquiry → create a Lead (reuses the buy-page enquiry
 *      pattern), deduping against a recent open lead with the same email.
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
    /* Recorded and parked, NOT parsed. The brief asks for Gemini OCR of vendor
     * invoice PDFs, and that cannot be honestly claimed yet: this webhook does
     * not receive attachments at all — the payload normaliser above reads text
     * and html only, and no provider attachment field is wired. Inventing a
     * bill from the message body would create vendor bills that quietly
     * disagree with the PDF nobody parsed, which is worse than not having the
     * feature. The mail is captured under route='billing' so it is visible and
     * nothing is lost while the attachment path is built. */
    await finalize("billing_received", null, null);
    return NextResponse.json({
      received: true,
      route: "billing",
      note: "Recorded. Attachment parsing is not wired yet — no vendor bill was created.",
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

  if (!extracted.isEnquiry) {
    await finalize("skipped_non_enquiry", null);
    return NextResponse.json({ received: true, skipped: "non_enquiry" });
  }

  const company = extracted.company || fromName || (fromEmail.split("@")[1]?.split(".")[0]) || "Email lead";
  const note    = [
    `Inbound email lead (auto-captured).`,
    `From: ${fromName ? `${fromName} ` : ""}<${fromEmail}>`,
    subject ? `Subject: ${subject}` : null,
    extracted.summary ? `Summary: ${extracted.summary}` : null,
    text ? `\n--- original ---\n${text.slice(0, 1000)}` : null,
  ].filter(Boolean).join("\n");

  // ── 5. Dedup — recent OPEN lead with the same email? append, don't dup ─
  const { data: existing } = await admin
    .from("leads")
    .select("id, notes, owner_id")
    .eq("tenant_id", tenantId)
    .ilike("contact_email", fromEmail)
    .not("stage", "in", "(won,lost)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
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
