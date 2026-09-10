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
import { decideRegistrationRetry } from "@/lib/domains/retry";

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

  /**
   * Record a paid-but-undelivered hosting account, so it is VISIBLE.
   *
   * ─── WHAT THIS FIXES ───────────────────────────────────────────
   * Until 11 Sep this route wrote to `hosting_accounts` exactly ONCE, inside the
   * success path. A customer who paid and whose provisioning failed left behind a
   * failed `provisioning_requests` row and an email — and NOTHING in
   * `hosting_accounts`, so /portal/hosting showed them an empty page. They had
   * paid, had no hosting, and the screen that should have explained it had
   * nothing to say. There was also nothing for an operator queue to read.
   *
   * `provision-domain` has always done this on every branch, and its header says
   * why: "The asset row is kept (not deleted) carrying the reason, so the desk
   * can see the attempt." This is the hosting half of that.
   *
   * The row is written as `failed`, never deleted, and carries the amount so the
   * money is answerable from one place. `attempt_count` is what the shared retry
   * budget in lib/domains/retry.ts measures.
   */
  async function recordHostingFailure(args: {
    tenantId: string;
    quoteId: string;
    requestId: string;
    domain: string;
    pkg: string;
    planCode: string | null;
    amountPaid: number | null;
    reason: string;
    kind: "hard_failure" | "collision_exhausted" | "server_unreachable";
  }): Promise<void> {
    const { data: customerRow } = await admin
      .from("quotes").select("customer_id").eq("id", args.quoteId).maybeSingle();
    if (!customerRow?.customer_id) {
      /* No customer on the quote — the same hole the success path logs. Without
         one there is no owner for the row, and inventing a placeholder would put a
         paid failure under nobody's name. Said out loud rather than dropped. */
      console.error(
        `[provision-hosting] ${args.quoteId} failed AND has no customer — nothing recorded against an owner: ${args.reason}`,
      );
      return;
    }

    /* Read the attempt count first so it can be carried forward. Upsert on
       `domain_name` because a retry must update the same row rather than fight
       the unique index — the same reason the success path upserts. */
    const { data: existing } = await admin
      .from("hosting_accounts")
      .select("attempt_count")
      .eq("domain_name", args.domain)
      .is("deleted_at", null)
      .maybeSingle();

    const { error } = await admin.from("hosting_accounts").upsert({
      tenant_id: args.tenantId,
      customer_id: customerRow.customer_id,
      domain_name: args.domain,
      status: "failed",
      da_package: args.pkg,
      plan_code: args.planCode,
      plan_name: args.pkg,
      is_trial: false,
      quote_id: args.quoteId,
      provisioning_request_id: args.requestId,
      amount_paid: args.amountPaid,
      attempt_count: (existing?.attempt_count ?? 0) + 1,
      last_attempt_at: new Date().toISOString(),
      last_error: args.reason,
      last_error_at: new Date().toISOString(),
      last_error_kind: args.kind,
    }, { onConflict: "domain_name" });

    if (error) {
      /* Logged and swallowed: the provisioning request is already marked failed
         and the owner has been emailed, so losing this row degrades the queue
         rather than the alert. Failing the whole run here would stop the other
         orders in the batch from being attempted at all. */
      console.error("[provision-hosting] could not record the failure row:", error.message);
    }
  }
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
        /* Deliberately NOT recorded as a hosting_accounts row: `domain_name` is
           NOT NULL and is the row's identity, so there is nothing to key it on.
           A synthetic placeholder would put a fake domain in the customer's
           portal. The provisioning request carries the reason and the owner has
           been emailed — this one genuinely belongs on the quote, not on an
           asset that cannot exist yet. */
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

      /* ── Has this one already failed, and is it still worth another go? ─────
         The SAME budget the domain path uses — five attempts on a 1h/4h/12h/24h
         backoff — because the thing being waited on is identical in both cases: a
         person fixing something upstream, usually within a working day.

         Sharing the policy rather than writing a second one is deliberate. Two
         retry budgets that drift apart is the defect family this repo keeps
         finding in ported code, and there is no reason hosting should wait a
         different length of time than a domain does. */
      const { data: priorAttempt } = await admin
        .from("hosting_accounts")
        .select("status, attempt_count, last_attempt_at, resolved_at")
        .eq("domain_name", domain)
        .is("deleted_at", null)
        .maybeSingle();

      if (priorAttempt?.status === "failed") {
        const decision = decideRegistrationRetry({
          status: priorAttempt.status,
          attemptCount: priorAttempt.attempt_count ?? 0,
          lastAttemptAt: priorAttempt.last_attempt_at,
          resolvedAt: priorAttempt.resolved_at,
        });
        if (decision.kind !== "retry") {
          /* Budget spent, too soon, or a person has already dealt with it. The
             last of those matters most: re-provisioning something that was
             refunded would create an account nobody is paying for. */
          console.log(
            `[provision-hosting] ${domain}: ${decision.kind}` +
            ("reason" in decision ? ` — ${decision.reason}` : ""),
          );
          result.skipped++;
          result.details.push({ quote_id: r.quote_id, outcome: `not-retrying (${decision.kind})` });
          continue;
        }
        console.log(`[provision-hosting] retrying ${domain}, attempt ${(priorAttempt.attempt_count ?? 0) + 1}`);
      }

      const username = genUsername(domain);
      const password = genPassword();
      const res = await daCreateAccount({ username, password, email: email || "owner@anutech.in", domain, pkg });

      if (!res.ok) {
        await markProvisioningFailed(r.id, res.message);
        /* The row that makes this visible — on /portal/hosting to the customer
           who paid, and in the operator queue on /assets/hosting. Before this,
           a refused DirectAdmin left nothing but an email. */
        await recordHostingFailure({
          tenantId: r.tenant_id, quoteId: r.quote_id, requestId: r.id,
          domain, pkg, planCode: r.plan ?? null, amountPaid: r.amount_paid,
          reason: res.message,
          /* `server_unreachable` reads differently to an operator than a refusal
             does — one waits, the other needs a decision — so the wording DA gave
             us decides which, rather than everything landing in one bucket. */
          kind: /unreachable|could not reach|timeout|ETIMEDOUT|ECONNREFUSED/i.test(res.message)
            ? "server_unreachable"
            : "hard_failure",
        });
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

      /* Record what the customer now OWNS (migration 20260908100000).
         Until this write existed, a provisioned account lived only on the
         DirectAdmin server and as a `vendor_ref` on the queue row — nothing the
         customer could ever be shown, which is why /portal/hosting had nothing
         to list. `upsert` on the domain keeps a re-run idempotent, matching
         daCreateAccount's own idempotency: the worker may legitimately run
         twice over the same request and must not leave two accounts behind.

         Non-fatal on failure. The cPanel account is already real and the login
         email is about to go out; losing the bookkeeping row must not turn a
         working account into a "failed" one. It is logged and the sweep can
         re-derive it from DirectAdmin. */
      try {
        const { data: customerRow } = await admin
          .from("quotes").select("customer_id").eq("id", r.quote_id).maybeSingle();
        if (customerRow?.customer_id) {
          const { error: assetErr } = await admin.from("hosting_accounts").upsert({
            tenant_id:   r.tenant_id,
            customer_id: customerRow.customer_id,
            domain_name: domain,
            status:      "active",
            da_username: username,
            da_package:  pkg,
            plan_code:   r.plan ?? null,
            plan_name:   pkg,
            is_trial:    false,
            started_at:  new Date().toISOString(),
            quote_id:    r.quote_id,
            provisioning_request_id: r.id,
            last_synced_at: new Date().toISOString(),
          }, { onConflict: "domain_name" });
          if (assetErr) console.error("[provision-hosting] asset row not written:", assetErr.message);
        } else {
          console.error(`[provision-hosting] quote ${r.quote_id} has no customer — account provisioned but not recorded as owned`);
        }
      } catch (e) {
        console.error("[provision-hosting] asset row crashed:", (e as Error).message);
      }

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
