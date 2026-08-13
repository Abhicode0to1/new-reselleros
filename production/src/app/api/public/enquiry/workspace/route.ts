/**
 * POST /api/public/enquiry/workspace
 *
 * Public lead-capture endpoint for the /buy/workspace landing page.
 * Anonymous visitors hit this — no auth required.
 *
 * On a successful submission we now do TWO things atomically (well, sequentially
 * — Supabase doesn't expose a JS-level multi-row transaction, but a failed
 * quote insert leaves the lead in place, which is acceptable degradation):
 *
 *   1. Create a `leads` row (stage='new', source='buy-workspace')
 *   2. **Auto-create a `draft` quote** with the visitor's tier + seat count
 *      and a 7-day expiry, linked back to the lead.
 *
 * The auto-draft collapses pipeline stage 5 ("Pardeep manually builds quote")
 * from ~15 minutes to zero. Pardeep just opens the lead in the app, glances
 * at the pre-populated quote, hits Send. Customer gets a GST-compliant quote
 * email within minutes of clicking "Email me a quote" on the buy page.
 *
 * PRICING (audit fix #10/#11, 2026-05-30): the auto-quote price now comes from
 * the SHARED catalog-driven module (src/lib/pricing/workspace.ts) — the SAME one
 * the public checkout uses. Previously this route hardcoded ₹270/₹864/₹1080 per
 * user, which diverged wildly from the catalog (₹136/₹736), so "Get a quote"
 * quoted a different price than "Buy now" for the same tier. Now both agree, and
 * `items.msrp` (retail) is the single source of truth.
 *
 * v1 limitation: single-tenant (routes leads to Excel Tech). When we add
 * subdomain-based multi-tenancy (excel.resellersos.app), we'll resolve
 * the tenant from the request host instead.
 *
 * Security:
 * - Validated with Zod (rejects malformed bodies)
 * - Uses admin client (bypasses RLS — required since visitor has no session)
 * - Rate limit TODO: bolt on at the edge later (Cloudflare or upstream proxy)
 */
import { NextResponse, type NextRequest } from "next/server";
import { captureFromRequest } from "@/lib/marketing/utm";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";
import {
  fetchWorkspaceCatalogPrice,
  buildWorkspaceLines,
  TIER_DISPLAY_NAME,
} from "@/lib/pricing/workspace";

// Pardeep's inbox — the reseller owner who sees every new buy-page lead.
// Hardcoded for v1 (single tenant); resolve per-tenant once we go multi-tenant.
const PARDEEP_EMAIL = "Pardeep@exceltechnologies.in";
const FROM_EMAIL    = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const APP_URL       = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://resellersos.web.app";

// The tenant that owns the /buy/workspace storefront. Explicit env var keeps
// this from drifting when new tenants get added (the previous "oldest tenant"
// heuristic broke when seed data created an earlier Excel Tech tenant that
// Pardeep wasn't logged in as). Falls back to the active Excel Tech tenant.
const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";

const enquirySchema = z.object({
  fullName:    z.string().min(2).max(120),
  companyName: z.string().min(2).max(200),
  email:       z.string().email().max(200),
  phone:       z.string().min(10).max(20),
  seats:       z.coerce.number().int().min(1).max(10000),
  tierId:      z.enum(["starter", "standard", "plus", "enterprise"]),
  billing:     z.enum(["monthly", "annual"]),
  message:     z.string().max(2000).optional(),
  // Optional GST place-of-supply. Drives IGST vs CGST+SGST once the lead
  // converts to a customer (state copied through accept_quote / record_payment).
  stateCode:   z.string().regex(/^\d{2}$/, "state code must be 2 digits").optional(),
  state:       z.string().max(60).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = enquirySchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid form data: " + parsed.error.issues.map(i => i.message).join(", ") },
        { status: 400 },
      );
    }

    const { fullName, companyName, email, phone, seats, tierId, billing, message, stateCode, state } = parsed.data;

    const admin = createAdminClient();

    // ── Route to the explicit buy-page tenant ─────────────────────────────
    // We used to pick "oldest tenant by created_at", but seed data introduced
    // an earlier Excel Tech tenant that the logged-in operator can't see, so
    // leads landed in the wrong inbox. Use BUY_PAGE_TENANT_ID env var instead.
    const tenantId = BUY_PAGE_TENANT_ID;

    // ── Price from the catalog (single source of truth, shared with checkout)
    const catalogRow = await fetchWorkspaceCatalogPrice(admin, tenantId, tierId);
    const lines      = buildWorkspaceLines(catalogRow, tierId, seats);
    const tierName   = TIER_DISPLAY_NAME[tierId];

    // ── Insert lead ────────────────────────────────────────────────────────
    const leadId    = "L-" + Date.now().toString(36).toUpperCase();
    const planLabel = `google-workspace-${tierId}`;
    const value     = lines.subtotal;   // ₹ ex-GST annual, catalog-derived (ranking)

    const leadNotes = [
      `Submitted via /buy/workspace`,
      `Billing preference: ${billing}`,
      message ? `Message: ${message}` : null,
    ].filter(Boolean).join("\n");

    const { error: leadErr } = await admin.from("leads").insert({
      id:            leadId,
      tenant_id:     tenantId,
      company:       companyName,
      contact_name:  fullName,
      contact_email: email,
      contact_phone: phone,
      plan:          planLabel,
      seats,
      value,
      stage:         "new",
      source:        "buy-workspace",
      // Migration 0232 — inbound attribution. Nulls when nothing was captured.
      ...captureFromRequest(request, body as Record<string, unknown>),
      notes:         leadNotes,
      // Place-of-supply for GST (copied to the customer on conversion). Optional —
      // blank falls back to intra-state until set on the customer in-app.
      state_code:    stateCode ?? null,
      state:         state ?? null,
    });

    if (leadErr) {
      console.error("[/api/public/enquiry/workspace] lead insert failed:", leadErr);
      return NextResponse.json(
        { error: "Could not save your enquiry. Please call us directly." },
        { status: 500 },
      );
    }

    // ── Auto-create draft quote — collapses pipeline stage 5 ──────────────
    // Skip for Enterprise (custom pricing — Pardeep hand-prices) and for any
    // tier the catalog can't price. Retry up to 3 times if the doc-number RPC
    // returns a value already in `quotes` (counter drift from earlier seed data).
    let draftQuoteId: string | null = null;
    const canAutoQuote = tierId !== "enterprise" && lines.items.length > 0;

    if (canAutoQuote) {
      const today    = new Date();
      const expires  = new Date(today);
      expires.setDate(expires.getDate() + 7);

      for (let attempt = 1; attempt <= 3 && !draftQuoteId; attempt++) {
        const { data: quoteId, error: numErr } = await admin
          .rpc("next_document_number", { p_doc_type: "quote", p_tenant_id: tenantId });

        if (numErr || !quoteId) {
          console.error(`[enquiry/workspace] next_document_number attempt ${attempt} failed:`, numErr);
          break;
        }

        const { error: quoteErr } = await admin.from("quotes").insert({
          id:            quoteId as string,
          tenant_id:     tenantId,
          customer_id:   null,
          customer_name: companyName,
          lead_id:       leadId,
          plan:          planLabel,
          seats,
          line_items:    lines.items,        // ← real product rows (catalog-priced)
          subtotal:      lines.subtotal,     // ← ex-GST
          total_cost:    lines.items.reduce((s, i) => s + i.qty * i.cost, 0),
          discount_pct:  0,
          tax_rate:      18,                 // CGST 9 + SGST 9 (or IGST 18)
          amount:        lines.amount,       // ← incl-GST total (matches checkout)
          status:        "draft",
          owner_id:      null,
          created_date:  today.toISOString().slice(0, 10),
          expires_date:  expires.toISOString().slice(0, 10),
          notes:         `Auto-generated from /buy/workspace enquiry. Customer wants ${seats} seat${seats === 1 ? "" : "s"} of Google Workspace ${tierName}.`,
        });

        if (!quoteErr) {
          draftQuoteId = quoteId as string;
          break;
        }

        // Postgres unique-violation code = 23505 — retry pulls the next number.
        if (quoteErr.code === "23505") {
          console.warn(`[enquiry/workspace] quote ID collision on attempt ${attempt}: ${quoteId}. Retrying...`);
          continue;
        }

        // Any other failure — log and bail (lead is still saved, Pardeep can
        // build the quote manually).
        console.error(`[enquiry/workspace] quote insert failed on attempt ${attempt}:`, quoteErr);
        break;
      }

      if (draftQuoteId) {
        // Annotate the lead so Pardeep sees the auto-quote ID in the lead drawer
        await admin
          .from("leads")
          .update({
            notes: `${leadNotes}\n\nAuto-generated draft quote: ${draftQuoteId} (₹${lines.amount.toLocaleString("en-IN")} incl GST, valid 7 days)`,
          })
          .eq("id", leadId);
      }
    }

    // ── Fire two notification emails (best-effort, don't block response) ──
    // 1. Pardeep gets a "new buy-page lead" alert with all the lead details
    //    plus a direct deep-link to the auto-quote (if it got created)
    // 2. The customer gets an instant acknowledgement so they don't feel
    //    ghosted between submission and Pardeep's call-back
    //
    // We don't `await` these in series because we want the API to respond
    // fast (form-submit UX) — but we do `await` both so any errors get
    // logged. The user-facing response is unaffected if email fails (the
    // lead is already saved).
    const valueFmt = `₹${value.toLocaleString("en-IN")}`;
    const draftUrl = draftQuoteId ? `${APP_URL}/quotes/${draftQuoteId}` : `${APP_URL}/leads`;

    await Promise.allSettled([
      // ── EMAIL 1: Pardeep alert ────────────────────────────────────────
      sendEmail({
        to:      PARDEEP_EMAIL,
        from:    FROM_EMAIL,
        replyTo: email,            // Pardeep can hit Reply to talk to lead directly
        subject: `🔔 New ${tierName} lead — ${companyName} (${seats} users · ${valueFmt})`,
        text:
`A new buy-page enquiry just landed in your pipeline.

COMPANY     ${companyName}
CONTACT     ${fullName} <${email}>
PHONE       ${phone}
PLAN        Google Workspace ${tierName}
SEATS       ${seats}
EST. VALUE  ${valueFmt}/year
BILLING     ${billing}
${message ? `MESSAGE     ${message}\n` : ""}
${draftQuoteId
  ? `A draft quote (${draftQuoteId}) has already been generated and is ready to send.\nReview & send: ${draftUrl}`
  : `Open the lead to build a quote:\n${APP_URL}/leads/${leadId}`}

— ResellerOS`,
      }),

      // ── EMAIL 2: Customer acknowledgement ─────────────────────────────
      sendEmail({
        to:      email,
        from:    FROM_EMAIL,
        replyTo: PARDEEP_EMAIL,
        subject: `Got it, ${fullName.split(" ")[0]} — your Google Workspace quote is on the way`,
        text:
`Hi ${fullName.split(" ")[0]},

Thanks for the enquiry. Here's what you'll get from us in the next 30 minutes:

• A WhatsApp message from Pardeep (he runs Excel Technologies himself)
• A custom GST quote for ${seats} Google Workspace ${tierName} users
• Answers to any migration / setup / pricing questions

WHAT WE HAVE FROM YOU
  Company    ${companyName}
  Plan       Google Workspace ${tierName}
  Seats      ${seats}
  Billing    ${billing}

Quote ready in your inbox shortly. If you'd rather call us directly: +91 99999 30300 (Mon–Sat, 9am–9pm IST).

— Pardeep Sharma
   Founder, Excel Technologies
   Google Premier Partner · since 2014`,
      }),
    ]).then((results) => {
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          console.error(`[enquiry/workspace] notification email ${i === 0 ? "to Pardeep" : "to customer"} failed:`, r.reason);
        } else if (r.value.status === "failed") {
          console.error(`[enquiry/workspace] notification email ${i === 0 ? "to Pardeep" : "to customer"} failed:`, r.value.errorMessage);
        }
      });
    });

    return NextResponse.json({ success: true, leadId, draftQuoteId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/public/enquiry/workspace] crashed:", message);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
