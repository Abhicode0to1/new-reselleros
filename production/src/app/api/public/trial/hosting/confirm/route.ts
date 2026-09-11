/**
 * GET /api/public/trial/hosting/confirm?token=…
 *
 * The customer clicks this from the confirmation email (the trial's bot guard).
 * It verifies the signed token, then — if live provisioning is enabled and the
 * customer already has a domain — creates the cPanel account on DirectAdmin and
 * emails the login. Otherwise it records the confirmation and alerts the owner
 * to provision by hand (a domain-less trial can't be auto-created). Either way
 * it redirects to a friendly page; it never shows a raw error or a token.
 *
 * ─── The live-provisioning gate ─────────────────────────────────────────────
 * Creating a real account is irreversible, so it fires ONLY when
 * HOSTING_TRIAL_LIVE=1 is set on the server (the ALLOW_*-style switch). Until
 * that flag is flipped — after a controlled test account is created and deleted
 * by hand, on Pardeep's go — every confirmation falls through to the
 * notify-owner path, so the whole flow can ship and be exercised safely first.
 *
 * Idempotency: daCreateAccount refuses if the account already exists, so a link
 * clicked twice cannot create two accounts.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";
import { verifyTrialToken } from "@/lib/hosting/trial-token";
import { daCreateAccount, genUsername, genPassword } from "@/lib/directadmin/provision";
import { hostingProvisioningEnabled } from "@/lib/directadmin/provision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FROM_EMAIL = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://resellersos.web.app";
const DA_LOGIN_URL = (process.env.DIRECTADMIN_URL?.trim() || "").replace(/\/+$/, "");
const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";
const TRIAL_DAYS = 15;
const PKG_NAME: Record<string, string> = { starter: "Starter", standard: "Standard", plus: "Plus" };

function done(status: string): NextResponse {
  return NextResponse.redirect(`${APP_URL}/hosting/trial?confirmed=${status}`);
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") || "";
  const verdict = verifyTrialToken(token);
  if (!verdict.ok) return done(verdict.reason === "expired" ? "expired" : "invalid");

  const admin = createAdminClient();
  const { data: lead } = await admin
    .from("leads")
    .select("id, company, contact_name, contact_email, contact_phone, plan, domain, source, notes, trial_converted_at")
    .eq("id", verdict.leadId)
    .eq("tenant_id", BUY_PAGE_TENANT_ID)
    .maybeSingle();

  if (!lead || lead.source !== "buy-hosting-trial") return done("invalid");
  if (lead.trial_converted_at) return done("already");

  const tier = (lead.plan || "").replace(/^hosting-/, "") || "standard";
  const pkg = PKG_NAME[tier] || "Standard";
  const domain = (lead.domain || "").trim();
  const email = lead.contact_email || "";
  const firstName = (lead.contact_name || "there").split(" ")[0];

  const canProvision = hostingProvisioningEnabled() && domain.length >= 3;

  // Re-anchor the trial clock to confirmation time (the 15 days start now).
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + TRIAL_DAYS * 86400000);

  if (!canProvision) {
    // Domain-less trial, or live gate off — record the confirmation and hand it
    // to the owner to provision (or help register a domain).
    await admin.from("leads").update({
      trial_started_at: startedAt.toISOString(),
      trial_expires_at: expiresAt.toISOString(),
      notes: `${lead.notes || ""}\n\n[${startedAt.toISOString()}] EMAIL CONFIRMED — ${domain ? "ready to provision" : "needs a domain first"}. Provision the ${pkg} cPanel account and send the login.`,
    }).eq("id", lead.id);

    const { alert: owner } = await loadOwnerAlert(admin, BUY_PAGE_TENANT_ID);
    if (owner.ok) {
      await sendEmail({
        to: owner.to, from: FROM_EMAIL, kind: "buy_page_trial_owner", route: { tenantId: BUY_PAGE_TENANT_ID }, replyTo: email,
        subject: `✅ HOSTING TRIAL CONFIRMED — ${lead.company} (${pkg})`,
        text: `${lead.company} confirmed their email for a ${pkg} hosting trial.\n\n${domain ? `Domain: ${domain}\nProvision the cPanel account and send the login.` : `They still need a domain — help them register one, then provision.`}\n\nContact: ${lead.contact_name} <${email}> · ${lead.contact_phone}\nOpen the lead: ${APP_URL}/leads/${lead.id}\n\n— ResellerOS`,
      }).catch(() => {});
    }
    return done(domain ? "pending" : "needdomain");
  }

  // ── Live provisioning (irreversible) ──────────────────────────────────────
  const username = genUsername(domain);
  const password = genPassword();
  const result = await daCreateAccount({ username, password, email, domain, pkg });

  if (!result.ok) {
    // Never expose DA internals to the visitor — record it and alert the owner.
    await admin.from("leads").update({
      notes: `${lead.notes || ""}\n\n[${startedAt.toISOString()}] AUTO-PROVISION FAILED: ${result.message}. Provision by hand.`,
    }).eq("id", lead.id);
    const { alert: owner } = await loadOwnerAlert(admin, BUY_PAGE_TENANT_ID);
    if (owner.ok) {
      await sendEmail({
        to: owner.to, from: FROM_EMAIL, kind: "buy_page_trial_owner", route: { tenantId: BUY_PAGE_TENANT_ID }, replyTo: email,
        subject: `⚠️ HOSTING TRIAL — auto-provision failed for ${lead.company}`,
        text: `Auto-provisioning the ${pkg} account for ${domain} failed:\n\n  ${result.message}\n\nProvision by hand and send the login.\nLead: ${APP_URL}/leads/${lead.id}\n\n— ResellerOS`,
      }).catch(() => {});
    }
    return done("error");
  }

  // Success (or the account already existed — either way it's live).
  await admin.from("leads").update({
    trial_started_at: startedAt.toISOString(),
    trial_expires_at: expiresAt.toISOString(),
    notes: `${lead.notes || ""}\n\n[${startedAt.toISOString()}] AUTO-PROVISIONED ${pkg} · cPanel user: ${username} · domain: ${domain}${result.alreadyExisted ? " (already existed)" : ""}`,
  }).eq("id", lead.id);

  const { alert: owner } = await loadOwnerAlert(admin, BUY_PAGE_TENANT_ID);

  // Credential email to the customer (skip if the account merely already existed
  // — we must not re-send a password we didn't just set).
  if (!result.alreadyExisted && DA_LOGIN_URL) {
    await sendEmail({
      to: email, from: FROM_EMAIL, kind: "buy_page_trial_customer", route: { tenantId: BUY_PAGE_TENANT_ID },
      replyTo: owner.ok ? owner.to : undefined,
      subject: `Your ${pkg} hosting trial is live — your login is inside`,
      text: `Hi ${firstName},

Your ${TRIAL_DAYS}-day ${pkg} hosting trial is ready. Here's your control-panel login:

  Control panel : ${DA_LOGIN_URL}
  Username      : ${username}
  Password      : ${password}
  Domain        : ${domain}

Please change the password after your first login.

From here you can install WordPress, set up email, and upload your site. Moving
from another host? Reply to this email with your current login and we'll migrate
you for free — your old site stays live until you approve the switch.

No credit card. ${TRIAL_DAYS} days fully free. We'll check in before it ends.

— ${owner.ok ? owner.ownerName || "Your hosting team" : "Your hosting team"}`,
    }).catch(() => {});
  }

  if (owner.ok) {
    await sendEmail({
      to: owner.to, from: FROM_EMAIL, kind: "buy_page_trial_owner", route: { tenantId: BUY_PAGE_TENANT_ID },
      subject: `🚀 HOSTING TRIAL LIVE — ${lead.company} · ${pkg} · ${domain}`,
      text: `Auto-provisioned a ${pkg} cPanel account.\n\nCompany: ${lead.company}\ncPanel user: ${username}\nDomain: ${domain}\nContact: ${lead.contact_name} <${email}> · ${lead.contact_phone}\nTrial ends: ${expiresAt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}\n\nLead: ${APP_URL}/leads/${lead.id}\n\n— ResellerOS`,
    }).catch(() => {});
  }

  return done(result.alreadyExisted ? "already" : "provisioned");
}
