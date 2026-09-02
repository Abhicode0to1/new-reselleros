/**
 * POST /api/public/trial/hosting
 *
 * Public trial-request endpoint for the /hosting landing page's "Start free
 * trial" buttons. It is the hosting twin of /api/public/trial/workspace and
 * follows the SAME safe v1 model that flow uses: it CAPTURES the request as a
 * qualified lead (stage='trial'), alerts the owner, acknowledges the customer,
 * and schedules follow-up tasks. It does NOT create a cPanel account.
 *
 * Why not create the account here: provisioning a real DirectAdmin account is
 * irreversible resource use and stays behind the provisioning queue's gates
 * (test_mode / dial / vendor), enabled only on Pardeep's explicit go. So — as
 * with the Workspace trial, which is manual-provision for v1 — the account is
 * set up by Anutech from the lead once this fires. The customer's experience is
 * still self-serve and no-card: fill the form, get an instant confirmation, and
 * receive the cPanel login once the account is ready.
 */
import { NextResponse, type NextRequest } from "next/server";
import { captureFromRequest } from "@/lib/marketing/utm";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";

const FROM_EMAIL = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://resellersos.web.app";
const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";

const TRIAL_DAYS = 15;

const PLAN_NAMES: Record<string, string> = { starter: "Starter", standard: "Standard", plus: "Plus" };

const trialSchema = z.object({
  fullName: z.string().min(2).max(120),
  companyName: z.string().min(2).max(200),
  email: z.string().email().max(200),
  phone: z.string().min(10).max(20),
  tierId: z.enum(["starter", "standard", "plus"]).optional(),
  /** Their website domain (optional — a first-time site may not have one yet). */
  domain: z.string().max(120).optional(),
  domainStatus: z.enum(["have", "need"]).optional(),
  message: z.string().max(2000).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = trialSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid trial request: " + parsed.error.issues.map((i) => i.message).join(", ") },
        { status: 400 },
      );
    }

    const { fullName, companyName, email, phone, tierId, domain, domainStatus, message } = parsed.data;
    const cleanDomain = (domain || "")
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "")
      .trim();
    const tierName = tierId ? PLAN_NAMES[tierId] : "Standard (default)";

    const admin = createAdminClient();
    const leadId = "L-" + Date.now().toString(36).toUpperCase();

    const notes = [
      `HOSTING TRIAL REQUEST · ${TRIAL_DAYS}-day free trial (no card)`,
      `Plan to trial: ${tierName} hosting (cPanel on Google Cloud)`,
      domainStatus === "need"
        ? `Domain: needs a new domain`
        : cleanDomain
          ? `Domain: ${cleanDomain} (existing — migrate)`
          : `Domain: not specified`,
      `Submitted via /hosting/trial`,
      message ? `Message: ${message}` : null,
      ``,
      `NEXT STEPS (provisioning is gated — do this to start the trial):`,
      `  1. Create the ${tierName} cPanel account in DirectAdmin`,
      `  2. ${domainStatus === "need" ? "Help the customer register a domain" : `Set up ${cleanDomain || "their domain"} / offer free migration`}`,
      `  3. Send cPanel login to ${email} + WhatsApp ${phone}`,
      `  4. Day 12: conversion outreach; Day ${TRIAL_DAYS}: convert to paid or close`,
    ].filter(Boolean).join("\n");

    const trialStartedAt = new Date();
    const trialExpiresAt = new Date(trialStartedAt.getTime() + TRIAL_DAYS * 86400000);

    const { error: leadErr } = await admin.from("leads").insert({
      id: leadId,
      tenant_id: BUY_PAGE_TENANT_ID,
      company: companyName,
      contact_name: fullName,
      contact_email: email,
      contact_phone: phone,
      plan: tierId ? `hosting-${tierId}` : "hosting-trial",
      seats: 1,
      value: 0,
      stage: "trial",
      source: "buy-hosting-trial",
      ...captureFromRequest(request, body as Record<string, unknown>),
      domain: cleanDomain || null,
      notes,
      trial_started_at: trialStartedAt.toISOString(),
      trial_expires_at: trialExpiresAt.toISOString(),
    });

    if (leadErr) {
      console.error("[/api/public/trial/hosting] lead insert failed:", leadErr);
      return NextResponse.json(
        { error: "Could not start your trial — nothing was saved, so please try again. If it happens twice, email us using the address on this page and we will set it up by hand." },
        { status: 500 },
      );
    }

    // Follow-up tasks — best-effort (non-fatal).
    try {
      const day12 = new Date(trialStartedAt.getTime() + 12 * 86400000);
      const day15 = new Date(trialStartedAt.getTime() + TRIAL_DAYS * 86400000);
      day12.setHours(10, 0, 0, 0);
      day15.setHours(10, 0, 0, 0);
      await admin.from("tasks").insert([
        {
          tenant_id: BUY_PAGE_TENANT_ID,
          title: `Provision hosting trial: ${companyName} (${tierName})`,
          notes: `New ${TRIAL_DAYS}-day hosting trial. Create the ${tierName} cPanel account and send login to ${email}.`,
          kind: "followup",
          due_at: trialStartedAt.toISOString(),
          lead_id: leadId,
        },
        {
          tenant_id: BUY_PAGE_TENANT_ID,
          title: `Conversion call: ${companyName} — hosting trial ends in 3 days`,
          notes: `Day 12 of ${TRIAL_DAYS}-day hosting trial. Discuss converting to a paid ${tierName} plan.`,
          kind: "call",
          due_at: day12.toISOString(),
          lead_id: leadId,
        },
        {
          tenant_id: BUY_PAGE_TENANT_ID,
          title: `Hosting trial expires TODAY: ${companyName}`,
          notes: `${TRIAL_DAYS}-day hosting trial ends. Convert to paid or close the account.`,
          kind: "call",
          due_at: day15.toISOString(),
          lead_id: leadId,
        },
      ]);
    } catch (taskErr) {
      console.error("[/api/public/trial/hosting] task auto-create failed (non-fatal):", taskErr);
    }

    const trialEndsFmt = trialExpiresAt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

    const { alert: owner, tenant: ownerTenant } = await loadOwnerAlert(admin, BUY_PAGE_TENANT_ID);
    if (!owner.ok) {
      console.error(`[trial/hosting] lead ${leadId} saved, but no owner alert: ${owner.reason}`);
    }

    await Promise.allSettled([
      owner.ok && sendEmail({
        to: owner.to,
        from: FROM_EMAIL,
        kind: "buy_page_trial_owner",
        route: { tenantId: BUY_PAGE_TENANT_ID },
        replyTo: email,
        subject: `🎯 HOSTING TRIAL — ${companyName} · ${tierName} · ${cleanDomain || (domainStatus === "need" ? "needs domain" : "no domain")}`,
        text:
`A new hosting trial request just landed. The customer wants to try the
${tierName} plan for ${TRIAL_DAYS} days, no card.

COMPANY     ${companyName}
CONTACT     ${fullName} <${email}>
PHONE       ${phone}
PLAN        ${tierName} hosting (cPanel on Google Cloud)
DOMAIN      ${cleanDomain || (domainStatus === "need" ? "needs a new domain" : "not specified")}
TRIAL ENDS  ${trialEndsFmt} (${TRIAL_DAYS} days from today)
${message ? `MESSAGE     ${message}\n` : ""}
To start the trial, provision the cPanel account, then send the login.
Open the lead:
${APP_URL}/leads/${leadId}

— ResellerOS`,
      }),

      owner.ok && sendEmail({
        to: email,
        from: FROM_EMAIL,
        replyTo: owner.to,
        kind: "buy_page_trial_customer",
        route: { tenantId: BUY_PAGE_TENANT_ID },
        subject: `Your ${TRIAL_DAYS}-day hosting trial${cleanDomain ? ` — ${cleanDomain}` : ""}`,
        text:
`Hi ${fullName.split(" ")[0]},

Thanks for starting a hosting trial${ownerTenant?.name?.trim() ? ` with ${ownerTenant.name.trim()}` : ""}. Here's what happens next:

WITHIN A FEW HOURS
  • We set up your ${tierName} cPanel account on Google Cloud
  • ${domainStatus === "need" ? "We help you pick and register a domain" : `We set up ${cleanDomain || "your domain"} — and if you're moving from another host, the migration is free and your old site stays live until you approve the switch`}
  • You get your cPanel login by email and WhatsApp (${phone})

DAY 12
  • We check in about converting to a paid plan (the same GST pricing you saw) or extending / closing the trial

NO CREDIT CARD until you decide to continue. ${TRIAL_DAYS} days fully free. The
trial ends ${trialEndsFmt}.

If you'd like to talk before then, just reply to this email${ownerTenant?.phone?.trim() ? ` — or call/WhatsApp us on ${ownerTenant.phone.trim()}` : ""}.

— ${owner.ownerName || ownerTenant?.name?.trim() || "Your hosting team"}${
  ownerTenant?.name?.trim() && owner.ownerName !== ownerTenant.name.trim()
    ? `\n   ${ownerTenant.name.trim()}`
    : ""
}`,
      }),
    ]).then((results) => {
      const labels = ["owner alert", "customer acknowledgement"];
      results.forEach((r, i) => {
        if (r.status === "rejected") console.error(`[trial/hosting] ${labels[i]} failed:`, r.reason);
        else if (r.value && r.value.status === "failed") console.error(`[trial/hosting] ${labels[i]} failed:`, r.value.errorMessage);
      });
    });

    return NextResponse.json({ success: true, leadId, trialEnds: trialExpiresAt.toISOString() });
  } catch (err) {
    const m = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/public/trial/hosting] crashed:", m);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
