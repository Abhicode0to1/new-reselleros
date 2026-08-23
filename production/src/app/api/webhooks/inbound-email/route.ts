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
 *   5b. PHASE 1 — a reply that CHANGES what the customer wants (seats, product) is
 *      written into the lead, with the customer's own sentence recorded as the reason.
 *      Deterministic, not a model: lib/inbound/extract.ts. The quoted thread is
 *      stripped first, because a reply carries our previous message — and the numbers
 *      being corrected — underneath it.
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
import { stripQuoted } from "@/lib/inbound/strip-quoted";
import { extractEntities } from "@/lib/inbound/extract";
import { planQuoteFromEnquiry } from "@/lib/quotes/quote-from-enquiry";
import { planCorrections, correctionDetail } from "@/lib/leads/apply-correction";
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

  /* ── Is this our own mail coming back? ────────────────────────────────────
     Every reply on a thread arrives twice: once at the customer-facing address and
     once at the address we send FROM, because that address is in the thread. Those
     echoes used to be filed as spam. On 23 Aug 2026 I made an absent classification
     resolve to `create` so a real first email could not vanish during a Gemini outage
     — and that turned each echo into a NEW LEAD, named from our own domain
     ("anutech", no seats, no plan), sitting in New beside the real one. The operator
     spotted it within the hour.

     Exact addresses, never a domain match: a customer at our own domain is possible
     (a reseller buying for itself), and "anything @anutech.in is ours" would silently
     drop them. */
  const ourAddresses = new Set<string>();
  {
    const add = (v: string | null | undefined) => {
      const s = (v ?? "").trim().toLowerCase();
      if (s.includes("@")) ourAddresses.add(s);
    };
    const { data: t } = await admin
      .from("tenants").select("email").eq("id", tenantId).maybeSingle();
    add((t as { email?: string | null } | null)?.email);

    const { data: staff } = await admin
      .from("users").select("id, email").eq("tenant_id", tenantId);
    const staffRows = (staff ?? []) as { id: string; email?: string | null }[];
    for (const u of staffRows) add(u.email);

    /* The connected Google account is the one replies actually leave from, and it need
       not equal any users.email — that is the point of the "Send as" picker.

       Scoped to THIS tenant's user ids. `user_google_tokens` has no tenant_id column,
       so an unfiltered read here would pull every tenant's connected address into
       `ourAddresses` — and then a genuine enquiry from another reseller's sending
       address would be silently dropped as "ours". This runs under the admin client,
       so there is no RLS to catch that; the filter IS the boundary. */
    const staffIds = staffRows.map((u) => u.id).filter(Boolean);
    if (staffIds.length > 0) {
      const { data: senders } = await admin
        .from("user_google_tokens").select("google_email").in("user_id", staffIds);
      for (const g of (senders ?? []) as { google_email?: string | null }[]) add(g.google_email);
    }
  }
  const senderIsOurs = ourAddresses.has(fromEmail.trim().toLowerCase());

  const disposition = decideDisposition({
    senderIsOurs,
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

    /* ── PHASE 1: write the customer's correction INTO the lead ──────────────
       Three attempts at fixing the reply DRAFT all missed the point: after a
       customer said twice that they wanted 20 users of Standard rather than 50 of
       Starter, `leads.seats` still read 50 and `leads.plan` still read Starter.
       While that is true, every quote, draft and renewal derived from the row is
       wrong too. So the record moves, and the reply is then correct because the
       facts are.

       No model is involved. lib/inbound/extract.ts reads seats and product with
       tested regexes and returns the sentence each value came from, so nothing can
       be invented and the audit trail is free. The quoted thread is stripped FIRST:
       a reply carries our own previous message underneath, containing the very
       numbers being corrected. Reading the raw body would overwrite 20 with 50 and
       cite the customer as the source. */
    const fresh = stripQuoted(text);
    const { data: catalogue } = await admin
      .from("items")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .eq("is_active", true);

    const { data: leadFacts } = await admin
      .from("leads")
      .select("seats, plan")
      .eq("id", existing.id)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    const plan = planCorrections({
      current: {
        seats: (leadFacts as { seats?: number | null } | null)?.seats ?? null,
        plan:  (leadFacts as { plan?: string | null } | null)?.plan ?? null,
      },
      freshText: fresh.text,
      extracted: extractEntities({
        fromName, fromEmail, subject,
        body: fresh.text,
        catalogue: (catalogue ?? []) as { id: string; name: string }[],
      }),
    });

    if (plan.corrections.length > 0) {
      const patch: { seats?: number; plan?: string } = {};
      for (const c of plan.corrections) {
        if (c.field === "seats") patch.seats = c.value as number;
        if (c.field === "plan")  patch.plan  = c.value as string;
      }
      const { error: corrErr } = await admin
        .from("leads")
        .update(patch)
        .eq("id", existing.id)
        .eq("tenant_id", tenantId);

      if (corrErr) {
        /* The email is still filed and the reply still readable — only the record
           did not move. Said out loud rather than swallowed, because a correction
           that silently failed to apply is the state this whole change exists to
           remove. */
        console.error(`[webhooks/inbound-email] lead ${existing.id}: correction failed to apply: ${corrErr.message}`);
      } else {
        /* One row per field, each quoting the customer's own sentence. One combined
           row would make a single change impossible to undo on its own — and "says
           who?" is the first question anybody asks of an automated write. */
        await admin.from("lead_activities").insert(
          plan.corrections.map((c) => ({
            tenant_id: tenantId,
            lead_id: existing.id,
            kind: "correction_in",
            detail: correctionDetail(c),
          })),
        );
        console.info(
          `[webhooks/inbound-email] lead ${existing.id}: applied ${plan.corrections.length} correction(s) — ` +
          plan.corrections.map((c) => `${c.field} ${c.from ?? "(blank)"}->${c.to}`).join(", "),
        );
      }
    } else if (fresh.text.trim()) {
      /* Nothing to change is the common case and must not fill the log. Recorded at
         debug volume only, with the reasons, so "why didn't it update?" has an
         answer without a database query — the gap that made the Spam misfiling take
         one to diagnose. */
      console.info(
         `[webhooks/inbound-email] lead ${existing.id}: no correction — ` +
         plan.skipped.map((s) => `${s.field}: ${s.reason}`).join("; "),
      );
    }
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
  /* SEATS AND THE CATALOGUE PRODUCT, read here for the first time on this path.
     Traced 23 Aug 2026: `extracted` on this branch is the GEMINI result (`ExtractedLead`),
     and that shape has no `seats` field at all — so a new email lead has always been saved
     without a seat count, however plainly the mail stated one. The regex extractor that
     DOES read seats (`extractEntities`) was only ever run on the append branch below, for
     the Phase 1 correction write-back.

     That was the real break behind "50 Business Starter ka quote email par aa jayega?" —
     not the wording of the mail. Running it here costs one query and no AI call, and it is
     deterministic, which the model's answer is not.

     `stripQuoted` first, for the same reason the append path does it: a reply carries our
     own earlier numbers underneath, and reading THOSE would quote yesterday's figure. */
  const freshForFacts = stripQuoted(text).text || text;
  const { data: priceCatalogue } = await admin
    .from("items")
    .select("id, name, msrp, wholesale")
    .eq("tenant_id", tenantId)
    .eq("is_active", true);
  const catalogueForFacts = (priceCatalogue ?? []) as {
    id: string; name: string; msrp: number | null; wholesale: number | null;
  }[];
  const facts = extractEntities({
    fromName, fromEmail, subject,
    body: freshForFacts,
    catalogue: catalogueForFacts.map((c) => ({ id: c.id, name: c.name })),
  });
  const matchedItem = facts.product.value
    ? catalogueForFacts.find((c) => c.id === facts.product.value?.id) ?? null
    : null;

  const leadId = "L-" + Date.now().toString(36).toUpperCase();
  const { error: leadErr } = await admin.from("leads").insert({
    id:            leadId,
    tenant_id:     tenantId,
    company,
    contact_name:  extracted.contactName || null,
    contact_email: fromEmail,
    contact_phone: extracted.phone || null,
    /* The catalogue's own name when the regex matched one, because that string is what the
       quote builder and `samePlan` compare against. Gemini's free-text guess stays as the
       fallback — it is better than nothing when the mail named a product we do not sell. */
    plan:          matchedItem?.name || extracted.product || null,
    seats:         facts.seats.value,
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

  /* ── 6b. Draft quote, when the mail said enough to build one ───────────────
     `/buy/workspace` has auto-created a draft quote from a form submission for months;
     the email path never has. Same idea, same annual term, and the same "draft, never
     sent" rule — a human opens it before a customer sees it.

     The DECISION is in lib/quotes/quote-from-enquiry.ts, not here. This route is 700
     lines and has already produced two shipped bugs; money arithmetic inline would make
     it a third. Four of that planner's five outcomes are refusals, and each carries a
     reason, so a lead that could not be quoted says WHY on its own timeline instead of
     looking neglected.

     Failures here never fail the request. The lead is saved and the mail is filed by the
     time we get this far — losing those to a pricing problem would trade a real record
     for a convenience. */
  const quotePlan = planQuoteFromEnquiry({
    item:  matchedItem,
    seats: facts.seats.value,
    /* The sender's own words when they named a term, null when they did not. Null makes the
       draft an ASSUMED annual one, which is why it is recorded rather than smoothed over. */
    term:  facts.term.value,
  });
  if (!quotePlan.ok) {
    await admin.from("lead_activities").insert({
      tenant_id: tenantId, lead_id: leadId, kind: "note",
      detail: `No quote drafted automatically — ${quotePlan.reason}`,
    });
  } else {
    const today   = new Date();
    const expires = new Date(today);
    expires.setDate(expires.getDate() + 7);

    let draftQuoteId: string | null = null;
    /* Three attempts, matching the form path. `next_document_number` is the sole allocator
       and a collision means counter drift from older seed data, not a logic error — the
       next number is the fix. */
    for (let attempt = 1; attempt <= 3 && !draftQuoteId; attempt++) {
      const { data: quoteId, error: numErr } = await admin
        .rpc("next_document_number", { p_doc_type: "quote", p_tenant_id: tenantId });
      if (numErr || !quoteId) {
        console.error(`[inbound-email] next_document_number attempt ${attempt} failed:`, numErr);
        break;
      }
      const { error: quoteErr } = await admin.from("quotes").insert({
        id:            quoteId as string,
        tenant_id:     tenantId,
        customer_id:   null,
        customer_name: company,
        lead_id:       leadId,
        plan:          matchedItem?.name ?? null,
        seats:         facts.seats.value,
        line_items:    quotePlan.items,
        subtotal:      quotePlan.subtotal,
        total_cost:    quotePlan.items.reduce((s, i) => s + i.qty * i.cost, 0),
        discount_pct:  0,
        tax_rate:      18,
        amount:        quotePlan.amount,
        status:        "draft",
        owner_id:      null,
        created_date:  today.toISOString().slice(0, 10),
        expires_date:  expires.toISOString().slice(0, 10),
        /* The assumption in words on the document itself. Whoever opens this draft must
           read "term assumed annual" rather than work it out from the rate. */
        notes:
          `Auto-drafted from an inbound email from ${fromEmail}.\n` +
          `Read from the mail: ${facts.seats.source ?? "seats unknown"} · ` +
          `${facts.product.source ?? "product unknown"} · ` +
          `${facts.term.source ? `term "${facts.term.source}"` : "term not stated"}\n` +
          `${quotePlan.assumption}`,
      });
      if (!quoteErr) { draftQuoteId = quoteId as string; break; }
      if (quoteErr.code === "23505") {
        console.warn(`[inbound-email] quote id collision on attempt ${attempt}: ${quoteId}`);
        continue;
      }
      console.error("[inbound-email] quote insert failed:", quoteErr);
      break;
    }

    await admin.from("lead_activities").insert({
      tenant_id: tenantId, lead_id: leadId, kind: draftQuoteId ? "quote" : "note",
      detail: draftQuoteId
        ? `Draft quote ${draftQuoteId} auto-created — ${facts.seats.value} × ${matchedItem?.name}. Term assumed annual; check before sending.`
        : `Could not create the draft quote — the lead and the mail are saved, build it by hand`,
    });
  }
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
