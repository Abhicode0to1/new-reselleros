/**
 * Start a free hosting trial — the one place it happens.
 *
 * Moved here from POST /api/public/trial/hosting on 24 Sep 2026, when the trial
 * form page was removed (Pardeep: "Start free trial" should go to the cart, with
 * no page in between). The site cart checkout calls this for a
 * `hosting-trial:starter` line; nothing else does.
 *
 * Unchanged from the route it came from: it CAPTURES the request as a qualified
 * lead (stage='trial'), alerts the owner, emails the customer a confirmation
 * link, and schedules follow-up tasks. It does NOT create a cPanel account —
 * that happens only after the customer confirms their email
 * (api/public/trial/hosting/confirm), behind HOSTING_TRIAL_LIVE.
 *
 * Only Starter is trialled (owner, 24 Sep 2026) — see ./trial-plan.
 */
import type { NextRequest } from "next/server";
import { captureFromRequest } from "@/lib/marketing/utm";
import type { createAdminClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";
import { makeTrialToken } from "@/lib/hosting/trial-token";
import { TRIAL_PLAN_ID, TRIAL_PLAN_NAME } from "@/lib/hosting/trial-plan";

const FROM_EMAIL = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";

export const TRIAL_DAYS = 15;

export interface StartTrialInput {
  fullName: string;
  companyName: string;
  email: string;
  phone: string;
  /** Blank when the customer has no domain yet — the owner helps them pick one. */
  domain?: string;
  /** What the trial converts to. Recorded on the lead for the conversion call. */
  cycle: "monthly" | "yearly";
}

export type StartTrialResult =
  | { ok: true; leadId: string; trialEnds: string }
  | { ok: false; error: string };

export async function startHostingTrial(
  admin: ReturnType<typeof createAdminClient>,
  input: StartTrialInput,
  request: NextRequest,
  utmBody: Record<string, unknown>,
): Promise<StartTrialResult> {
  const { fullName, companyName, email, phone, domain, cycle } = input;
  const domainStatus: "have" | "need" = (domain ?? "").trim().length >= 3 ? "have" : "need";
  const tierId = TRIAL_PLAN_ID;
  const tierName = TRIAL_PLAN_NAME;
  const leadId = "L-" + Date.now().toString(36).toUpperCase();

  const cleanDomain = (domain || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .trim();


  const notes = [
    `HOSTING TRIAL REQUEST · ${TRIAL_DAYS}-day free trial (no card)`,
    `Plan to trial: ${tierName} hosting (cPanel on Google Cloud)`,
    `After the trial: ${tierName} billed ${cycle}`,
    domainStatus === "need"
      ? `Domain: needs a new domain`
      : cleanDomain
        ? `Domain: ${cleanDomain} (existing — migrate)`
        : `Domain: not specified`,
    `Submitted via the site cart checkout`,
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
    plan: `hosting-${tierId}`,
    seats: 1,
    value: 0,
    stage: "trial",
    source: "buy-hosting-trial",
    ...captureFromRequest(request, utmBody),
    domain: cleanDomain || null,
    notes,
    trial_started_at: trialStartedAt.toISOString(),
    trial_expires_at: trialExpiresAt.toISOString(),
  });

  if (leadErr) {
    console.error("[startHostingTrial] lead insert failed:", leadErr);
    return { ok: false, error: "Could not start your trial — nothing was saved, so please try again. If it happens twice, email us using the address on this page and we will set it up by hand." };
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
    console.error("[startHostingTrial] task auto-create failed (non-fatal):", taskErr);
  }

  const trialEndsFmt = trialExpiresAt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

  // Email-verification link — the bot guard. The account is provisioned only
  // after the customer clicks this. Without a signing secret configured we
  // can't verify a link, so we fall back to the manual "we'll set it up" note.
  const token = makeTrialToken(leadId);
  // Links are built from the request's own origin (AGENTS.md L112): it needs no
  // configuration and cannot point at a dead fallback host.
  const confirmUrl = token ? new URL(`/api/public/trial/hosting/confirm?token=${encodeURIComponent(token)}`, request.url).toString() : null;
  const firstName = fullName.split(" ")[0];

  const { alert: owner, tenant: ownerTenant } = await loadOwnerAlert(admin, BUY_PAGE_TENANT_ID);
  if (!owner.ok) {
    console.error(`[trial/hosting] lead ${leadId} saved, but no owner alert: ${owner.reason}`);
  }
  const ownerName = owner.ok ? owner.ownerName : "";
  const signOff = `— ${ownerName || ownerTenant?.name?.trim() || "Your hosting team"}${
    ownerTenant?.name?.trim() && ownerName !== ownerTenant.name.trim() ? `\n   ${ownerTenant.name.trim()}` : ""
  }`;
  const customerSubject = confirmUrl
    ? `Confirm your email to start your ${TRIAL_DAYS}-day hosting trial`
    : `Your ${TRIAL_DAYS}-day hosting trial${cleanDomain ? ` — ${cleanDomain}` : ""}`;
  const customerText = confirmUrl
    ? `Hi ${firstName},

One quick step to start your free ${TRIAL_DAYS}-day ${tierName} hosting trial —
confirm this is your email by opening the link below:

${confirmUrl}

As soon as you do${domainStatus === "need" ? ", we'll be in touch to help you pick a domain and set the account up" : `, we set up your ${tierName} cPanel account${cleanDomain ? ` for ${cleanDomain}` : ""} and email your login`}.
No credit card, ${TRIAL_DAYS} days fully free. The link is valid for 48 hours.

If you didn't request this, you can ignore this email — nothing happens without
that click.

${signOff}`
    : `Hi ${firstName},

Thanks for starting a ${tierName} hosting trial${ownerTenant?.name?.trim() ? ` with ${ownerTenant.name.trim()}` : ""}. We'll set up your
cPanel account and email your login within a few hours. No credit card, ${TRIAL_DAYS}
days fully free. Trial ends ${trialEndsFmt}.

${signOff}`;

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
To start the trial, provision the cPanel account, then send the login.
Open the lead:
${new URL(`/leads/${leadId}`, request.url).toString()}

— ResellerOS`,
    }),

    owner.ok && sendEmail({
      to: email,
      from: FROM_EMAIL,
      replyTo: owner.to,
      kind: "buy_page_trial_customer",
      route: { tenantId: BUY_PAGE_TENANT_ID },
      subject: customerSubject,
      text: customerText,
    }),
  ]).then((results) => {
    const labels = ["owner alert", "customer acknowledgement"];
    results.forEach((r, i) => {
      if (r.status === "rejected") console.error(`[trial/hosting] ${labels[i]} failed:`, r.reason);
      else if (r.value && r.value.status === "failed") console.error(`[trial/hosting] ${labels[i]} failed:`, r.value.errorMessage);
    });
  });

  return { ok: true, leadId, trialEnds: trialExpiresAt.toISOString() };
}
