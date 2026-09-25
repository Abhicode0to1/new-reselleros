/**
 * GET /api/public/trial/hosting/confirm?token=…
 *
 * The customer clicks this from the confirmation email (the trial's bot guard).
 * It verifies the signed token, then — if live provisioning is enabled and the
 * customer already has a domain — asks the DMS engine to create the trial account
 * (`hosting.provision` with `trial: true`). Otherwise it records the confirmation and
 * alerts the owner to provision by hand (a domain-less trial can't be auto-created).
 * Either way it redirects to a friendly page; it never shows a raw error or a token.
 *
 * ─── One DirectAdmin writer (25 Sep 2026) ──────────────────────────────────
 * Until this date the trial created the account on DirectAdmin FROM THIS APP, the
 * last path that did. It now goes through the engine like paid hosting, so DMS is
 * the only DirectAdmin writer and the trial lands in the customer's DMS account,
 * where they manage it. DMS emails them a "set your password" link for that panel.
 *
 * ─── The live-provisioning gate ─────────────────────────────────────────────
 * Creating a real account is irreversible, so it fires ONLY when HOSTING_TRIAL_LIVE=1
 * is set here AND the engine command key is configured; the engine applies its own
 * gate (ENGINE_HOSTING_PROVISION_LIVE=1). Until then every confirmation falls through
 * to the notify-owner path.
 *
 * Idempotency: one engine command id per lead (`rsos-hosttrial-<lead id>`), so a link
 * clicked twice replays the first answer instead of creating a second account.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";
import { verifyTrialToken } from "@/lib/hosting/trial-token";
import { isTrialPlan } from "@/lib/hosting/trial-plan";
import { commandsConfigured, sendEngineCommand } from "@/lib/dms-engine/commands";
import { dmsPanelUrl } from "@/lib/dms-engine/client";
import { normalisePhone, splitName } from "@/lib/provisioning/domain-registration";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FROM_EMAIL = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://resellersos.web.app";
const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";
const TRIAL_DAYS = 15;
const PKG_NAME: Record<string, string> = { starter: "Starter", standard: "Standard", plus: "Plus" };

/**
 * Where to send the customer after they click the confirm link.
 *
 * Built from the REQUEST's own origin, not from `APP_URL`. This is the only
 * customer-facing use of that constant in the file — everything else below is
 * an internal alert to staff — and its fallback is
 * `https://resellersos.web.app`, which answers **503** (measured 23 Sep 2026,
 * and L91 measured the same a month earlier). So with NEXT_PUBLIC_APP_URL
 * unset, a customer who clicked "confirm your email" landed on a dead host.
 *
 * The request's origin cannot be wrong and needs no configuration: whatever
 * hostname the customer actually reached us on is the one to send them back
 * to. That also survives this service having more than one hostname, which
 * L18 records it does.
 */
function done(req: NextRequest, status: string): NextResponse {
  return NextResponse.redirect(new URL(`/hosting/trial?confirmed=${status}`, req.url));
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") || "";
  const verdict = verifyTrialToken(token);
  if (!verdict.ok) return done(req, verdict.reason === "expired" ? "expired" : "invalid");

  const admin = createAdminClient();
  const { data: lead } = await admin
    .from("leads")
    .select("id, company, contact_name, contact_email, contact_phone, plan, domain, source, notes, trial_converted_at")
    .eq("id", verdict.leadId)
    .eq("tenant_id", BUY_PAGE_TENANT_ID)
    .maybeSingle();

  if (!lead || lead.source !== "buy-hosting-trial") return done(req, "invalid");
  if (lead.trial_converted_at) return done(req, "already");

  // A lead made before 24 Sep 2026 can still ask for Standard or Plus. Those are
  // no longer trialled, so they are never provisioned here: the owner is told and
  // offers Starter or a paid plan. The package is never guessed (it used to fall
  // back to Standard for an unknown plan).
  const tier = (lead.plan || "").replace(/^hosting-/, "");
  const trialPlanOk = isTrialPlan(tier);
  const pkg = PKG_NAME[tier] || "an unknown";
  const domain = (lead.domain || "").trim();
  const ownerStep = !trialPlanOk
    ? `They asked to trial ${pkg} hosting, which no longer has a free trial (only Starter does). Offer a Starter trial or a paid ${pkg} plan; do not provision ${pkg} free.`
    : domain
      ? "Provision the Starter cPanel account and send the login."
      : "They still need a domain — help them register one, then provision.";
  const email = lead.contact_email || "";
  const firstName = (lead.contact_name || "there").split(" ")[0];

  const canProvision = trialPlanOk && process.env.HOSTING_TRIAL_LIVE === "1" && commandsConfigured() && domain.length >= 3;

  // Re-anchor the trial clock to confirmation time (the 15 days start now).
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + TRIAL_DAYS * 86400000);

  if (!canProvision) {
    // Domain-less trial, or live gate off — record the confirmation and hand it
    // to the owner to provision (or help register a domain).
    await admin.from("leads").update({
      trial_started_at: startedAt.toISOString(),
      trial_expires_at: expiresAt.toISOString(),
      notes: `${lead.notes || ""}\n\n[${startedAt.toISOString()}] EMAIL CONFIRMED — ${ownerStep}`,
    }).eq("id", lead.id);

    const { alert: owner } = await loadOwnerAlert(admin, BUY_PAGE_TENANT_ID);
    if (owner.ok) {
      await sendEmail({
        to: owner.to, from: FROM_EMAIL, kind: "buy_page_trial_owner", route: { tenantId: BUY_PAGE_TENANT_ID }, replyTo: email,
        subject: `✅ HOSTING TRIAL CONFIRMED — ${lead.company} (${pkg})`,
        text: `${lead.company} confirmed their email for a ${pkg} hosting trial.\n\n${domain ? `Domain: ${domain}\n` : ""}${ownerStep}\n\nContact: ${lead.contact_name} <${email}> · ${lead.contact_phone}\nOpen the lead: ${APP_URL}/leads/${lead.id}\n\n— ResellerOS`,
      }).catch(() => {});
    }
    return done(req, !trialPlanOk ? "notrialplan" : domain ? "pending" : "needdomain");
  }

  // ── Live provisioning (irreversible), through the DMS engine ───────────────
  // The billing cycle the customer picked is recorded on the lead's notes by
  // lib/hosting/start-trial ("After the trial: Starter billed monthly|yearly").
  const cycle: "monthly" | "yearly" = /After the trial: \S+ billed monthly/.test(lead.notes || "") ? "monthly" : "yearly";
  const outcome = await sendEngineCommand({
    commandId: `rsos-hosttrial-${lead.id}`,
    command: "hosting.provision",
    subject: domain.toLowerCase(),
    mode: "live",
    payload: {
      planId: "starter",
      trial: true,
      paymentMode: "trial",
      cycle,
      // This trial is already in DMS's shared trial history under the lead id; naming it
      // stops it blocking itself (lib/dms-engine/trials.ts records it at checkout).
      trialRef: lead.id,
      customer: { ...splitName(lead.contact_name || email.split("@")[0]), email, ...normalisePhone(lead.contact_phone ?? ""), companyName: lead.company || undefined },
      sourceRef: lead.id,
    },
  });

  if (outcome.kind !== "done") {
    // Never expose engine internals to the visitor — record it and alert the owner.
    const why = `${outcome.kind}: ${outcome.reason}`;
    await admin.from("leads").update({
      trial_started_at: startedAt.toISOString(),
      trial_expires_at: expiresAt.toISOString(),
      notes: `${lead.notes || ""}\n\n[${startedAt.toISOString()}] EMAIL CONFIRMED — the trial account was NOT created automatically (${why}). Provision the Starter account by hand and send the login.`,
    }).eq("id", lead.id);
    const { alert: owner } = await loadOwnerAlert(admin, BUY_PAGE_TENANT_ID);
    if (owner.ok) {
      await sendEmail({
        to: owner.to, from: FROM_EMAIL, kind: "buy_page_trial_owner", route: { tenantId: BUY_PAGE_TENANT_ID }, replyTo: email,
        subject: `⚠️ HOSTING TRIAL — not created automatically for ${lead.company}`,
        text: `The Starter trial for ${domain} was confirmed, but the DMS engine did not create it:\n\n  ${why}\n\n${outcome.kind === "needs_reconciliation" ? "The request may have reached DirectAdmin: check DMS (Admin → Engine commands) before creating anything by hand.\n\n" : ""}Otherwise provision it by hand and send the login.\nLead: ${APP_URL}/leads/${lead.id}\n\n— ResellerOS`,
      }).catch(() => {});
    }
    return done(req, outcome.kind === "needs_reconciliation" || outcome.kind === "unreachable" ? "error" : "pending");
  }

  const r = outcome.result as { daUsername?: unknown; alreadyProvisioned?: unknown };
  const daUser = typeof r.daUsername === "string" ? r.daUsername : "(see DMS)";
  const already = r.alreadyProvisioned === true || outcome.replayed === true;
  await admin.from("leads").update({
    trial_started_at: startedAt.toISOString(),
    trial_expires_at: expiresAt.toISOString(),
    notes: `${lead.notes || ""}\n\n[${startedAt.toISOString()}] TRIAL ACCOUNT CREATED by the DMS engine · Starter · DirectAdmin user: ${daUser} · domain: ${domain}${already ? " (already existed)" : ""}`,
  }).eq("id", lead.id);

  const { alert: owner } = await loadOwnerAlert(admin, BUY_PAGE_TENANT_ID);

  // The customer: where the account lives. No password is sent from here — DMS emails a
  // "set your password" link for its customer panel when it creates their account.
  if (!already) {
    const panel = dmsPanelUrl("customer");
    const panelLine = panel
      ? `Manage it — control panel, email, WordPress — from your customer panel: ${panel}\nIf this is your first time there, use the "set your password" email we just sent you to sign in.`
      : `We'll send your sign-in details shortly.`;
    await sendEmail({
      to: email, from: FROM_EMAIL, kind: "buy_page_trial_customer", route: { tenantId: BUY_PAGE_TENANT_ID },
      replyTo: owner.ok ? owner.to : undefined,
      subject: `Your Starter hosting trial is live`,
      text: `Hi ${firstName},\n\nYour ${TRIAL_DAYS}-day Starter hosting trial for ${domain} is ready.\n\n${panelLine}\n\nMoving from another host? Reply to this email with your current login and we'll migrate you for free — your old site stays live until you approve the switch.\n\nNo credit card. ${TRIAL_DAYS} days fully free. We'll check in before it ends.\n\n— ${owner.ok ? owner.ownerName || "Your hosting team" : "Your hosting team"}`,
    }).catch(() => {});
  }

  if (owner.ok) {
    await sendEmail({
      to: owner.to, from: FROM_EMAIL, kind: "buy_page_trial_owner", route: { tenantId: BUY_PAGE_TENANT_ID },
      subject: `🚀 HOSTING TRIAL LIVE — ${lead.company} · Starter · ${domain}`,
      text: `The DMS engine created a Starter trial account.\n\nCompany: ${lead.company}\nDirectAdmin user: ${daUser}\nDomain: ${domain}\nContact: ${lead.contact_name} <${email}> · ${lead.contact_phone}\nTrial ends: ${expiresAt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}\n\nLead: ${APP_URL}/leads/${lead.id}\n\n— ResellerOS`,
    }).catch(() => {});
  }

  return done(req, already ? "already" : "provisioned");
}
