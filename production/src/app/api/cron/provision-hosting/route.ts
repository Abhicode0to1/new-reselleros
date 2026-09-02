/**
 * Provision-hosting worker — runs on a schedule (and can be poked by hand).
 *
 * This is the piece that turns a PAID hosting order into a live account. The
 * Razorpay webhook records the payment and queues a `provisioning_requests` row;
 * nothing executed it until now. For every hosting request that decideProvisioning
 * fully approved (blocker IS NULL, live payment), this:
 *   1. creates the cPanel account on DirectAdmin (permanent — no trial suspend),
 *   2. emails the customer their control-panel login,
 *   3. marks the request 'activated' with the cPanel username as vendor_ref.
 * A failure marks the row 'failed' and alerts the owner; nothing is charged again
 * and daCreateAccount is idempotent, so a re-run cannot double-create an account.
 *
 * Auth: same fail-closed Bearer(CRON_SECRET) pattern as the other crons.
 */
import { NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { daCreateAccount, daWriteConfigured, genUsername, genPassword } from "@/lib/directadmin/provision";
import { listReadyHostingRequests, markProvisioningActivated, markProvisioningFailed } from "@/lib/provisioning/provisioning.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FROM_EMAIL = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://resellersos.web.app";
const DA_LOGIN_URL = (process.env.DIRECTADMIN_URL?.trim() || "").replace(/\/+$/, "");
const PKG_NAME: Record<string, string> = { starter: "Starter", standard: "Standard", plus: "Plus" };

/** Cron secret (for the scheduler) OR a signed-in owner (for a manual run). */
async function authorized(req: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
    if (timingSafeEqualStr(m?.[1] ?? "", secret)) return true;
  }
  // Manual run: an owner opening the URL in their signed-in browser.
  try {
    const supabase = createClient();
    const { data: authData } = await supabase.auth.getUser();
    if (!authData?.user) return false;
    const { data: me } = await supabase.from("users").select("role").eq("id", authData.user.id).single();
    return me?.role === "owner";
  } catch {
    return false;
  }
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }

async function handle(req: Request) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!daWriteConfigured() || process.env.HOSTING_TRIAL_LIVE !== "1") {
    return NextResponse.json({ ran: true, activated: 0, note: "hosting provisioning not live (DA creds / HOSTING_TRIAL_LIVE)" });
  }

  const admin = createAdminClient();
  const ready = await listReadyHostingRequests();
  const result = { ran_at: new Date().toISOString(), total: ready.length, activated: 0, failed: 0, skipped: 0, details: [] as { quote_id: string; outcome: string }[] };

  for (const r of ready) {
    try {
      // Buyer + domain: from the quote and its lead.
      const { data: quote } = await admin.from("quotes").select("lead_id, customer_name, domain").eq("id", r.quote_id).maybeSingle();
      let email = "", name = "there";
      if (quote?.lead_id) {
        const { data: lead } = await admin.from("leads").select("contact_email, contact_name").eq("id", quote.lead_id).maybeSingle();
        email = lead?.contact_email ?? "";
        name = (lead?.contact_name ?? quote.customer_name ?? "there").split(" ")[0];
      }
      const domain = (r.domain || quote?.domain || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").trim();
      const tier = (r.plan || "").replace(/^hosting-/, "") || "standard";
      const pkg = PKG_NAME[tier] || "Standard";

      if (domain.length < 3) {
        // Paid, but we don't have a domain to build on — the owner must reach out.
        await markProvisioningFailed(r.id, "No domain on the order — contact the customer to provision.");
        const { alert: owner } = await loadOwnerAlert(admin, r.tenant_id);
        if (owner.ok) {
          await sendEmail({
            to: owner.to, from: FROM_EMAIL, kind: "razorpay_payment_owner", route: { tenantId: r.tenant_id },
            subject: `⚠️ Paid hosting order needs a domain — ${quote?.customer_name ?? r.quote_id}`,
            text: `A paid ${pkg} hosting order (${r.quote_id}) has no domain to provision on. Contact ${email || "the customer"} and set it up.\n${APP_URL}/quotes/${r.quote_id}`,
          }).catch(() => {});
        }
        result.failed++; result.details.push({ quote_id: r.quote_id, outcome: "no-domain" });
        continue;
      }

      const username = genUsername(domain);
      const password = genPassword();
      const res = await daCreateAccount({ username, password, email: email || "owner@anutech.in", domain, pkg });

      if (!res.ok) {
        await markProvisioningFailed(r.id, res.message);
        const { alert: owner } = await loadOwnerAlert(admin, r.tenant_id);
        if (owner.ok) {
          await sendEmail({
            to: owner.to, from: FROM_EMAIL, kind: "razorpay_payment_owner", route: { tenantId: r.tenant_id },
            subject: `⚠️ Hosting provisioning failed — ${quote?.customer_name ?? r.quote_id}`,
            text: `Auto-provisioning the paid ${pkg} account for ${domain} failed:\n\n  ${res.message}\n\nProvision by hand and send the login.\n${APP_URL}/quotes/${r.quote_id}`,
          }).catch(() => {});
        }
        result.failed++; result.details.push({ quote_id: r.quote_id, outcome: "da-failed" });
        continue;
      }

      await markProvisioningActivated(r.id, username);

      // Credential email — skip the password if the account merely already existed.
      if (email && DA_LOGIN_URL && !res.alreadyExisted) {
        const { alert: owner } = await loadOwnerAlert(admin, r.tenant_id);
        await sendEmail({
          to: email, from: FROM_EMAIL, kind: "razorpay_payment_customer", route: { tenantId: r.tenant_id },
          replyTo: owner.ok ? owner.to : undefined,
          subject: `Your ${pkg} hosting is live — your login is inside`,
          text: `Hi ${name},

Your ${pkg} hosting account is set up and ready. Here's your control-panel login:

  Control panel : ${DA_LOGIN_URL}
  Username      : ${username}
  Password      : ${password}
  Domain        : ${domain}

Please change the password after your first login. From here you can install
WordPress, set up email and upload your site. Moving from another host? Reply to
this email with your current login and we'll migrate you for free.

Your GST invoice for this order reaches you separately.

— ${owner.ok ? owner.ownerName || "Your hosting team" : "Your hosting team"}`,
        }).catch(() => {});
      }

      result.activated++; result.details.push({ quote_id: r.quote_id, outcome: res.alreadyExisted ? "already-existed" : "activated" });
    } catch (e) {
      console.error("[provision-hosting] request crashed:", (e as Error).message);
      await markProvisioningFailed(r.id, (e as Error).message).catch(() => {});
      result.failed++; result.details.push({ quote_id: r.quote_id, outcome: "crash" });
    }
  }

  return NextResponse.json(result);
}
