/**
 * Provision-domain worker — turns a PAID domain order into a real registration.
 *
 * The Razorpay webhook verifies the payment and queues a `provisioning_requests`
 * row; this is what executes it. For every domain request `decideProvisioning`
 * fully approved (blocker IS NULL, live payment, amount matched to the rupee),
 * it registers the name at ResellerClub, writes the `domains` asset row, and
 * marks the request activated with the registrar's order id.
 *
 * ─── THIS SPENDS MONEY, SO READ THE THREE RULES ──────────────────────────────
 *
 * 1. **A pending outcome is never retried.** ResellerClub reports "queued behind
 *    your balance", "locked for processing" and "you already have an order for
 *    this name" as errors, in prose. All three mean the registration may still
 *    complete upstream. Retrying buys the name twice. `mustNotRetry` in
 *    lib/resellerclub/classify.ts is the single predicate for this, and such a
 *    row is left QUEUED — not failed — so the next run re-checks by name rather
 *    than re-ordering.
 *
 * 2. **The claim comes before the call.** Each row is claimed by stamping
 *    `processing_until` on the asset row before ResellerClub is touched, so two
 *    Cloud Run instances cannot register the same name. DMS learned this from a
 *    real double-renewal (models/Domain.ts carries the same column for the same
 *    reason).
 *
 * 3. **A success with no order id is not a success we can file.** Without the
 *    registrar's order id the domain can never be renewed or transferred by this
 *    app. The row is written as `pending` and the id is looked up by name — the
 *    same recovery path used when a worker is torn down mid-flight, which is
 *    exactly how DMS stranded a real ₹1500 purchase on 7 Sep 2026.
 *
 * Auth: the same fail-closed Bearer(CRON_SECRET)-or-signed-in-owner pattern as
 * the other crons.
 */
import { NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import {
  rcRegisterDomain,
  rcOrderingEnabled,
  rcOrderIdFor,
  rcDomainDetails,
} from "@/lib/resellerclub/orders";
import { mustNotRetry } from "@/lib/resellerclub/classify";
import {
  listReadyEngineRequests,
  markProvisioningActivated,
  markProvisioningFailed,
} from "@/lib/provisioning/provisioning.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FROM_EMAIL = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://reselleros.anutech.in";

/** RC customer + contact the registrations are filed under. */
const RC_CUSTOMER_ID = process.env.RESELLERCLUB_CUSTOMER_ID?.trim() || "";
const RC_CONTACT_ID = process.env.RESELLERCLUB_CONTACT_ID?.trim() || "";

async function authorized(req: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
    if (timingSafeEqualStr(m?.[1] ?? "", secret)) return true;
  }
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

type Outcome = "registered" | "pending-upstream" | "failed" | "no-domain" | "no-customer" | "crash";

async function handle(req: Request) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!rcOrderingEnabled()) {
    return NextResponse.json({
      ran: true,
      registered: 0,
      note: "domain ordering is not live in this environment (RESELLERCLUB credentials / DOMAIN_REGISTER_LIVE=1)",
    });
  }
  if (!RC_CUSTOMER_ID || !RC_CONTACT_ID) {
    /* Refuse rather than guess. ResellerClub files a registration against a
       customer and a contact; sending the wrong ones puts the domain in
       somebody else's account, and unpicking that is a support case with the
       registrar, not a code fix. */
    return NextResponse.json({
      ran: true,
      registered: 0,
      note: "RESELLERCLUB_CUSTOMER_ID / RESELLERCLUB_CONTACT_ID are not set — a registration cannot be filed without them",
    });
  }

  const admin = createAdminClient();
  const ready = await listReadyEngineRequests("domain");
  const result = {
    ran_at: new Date().toISOString(),
    total: ready.length,
    registered: 0,
    pending: 0,
    failed: 0,
    details: [] as { quote_id: string; domain: string | null; outcome: Outcome }[],
  };

  for (const r of ready) {
    const domain = (r.domain ?? "")
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "")
      .trim();

    const note = (outcome: Outcome) =>
      result.details.push({ quote_id: r.quote_id, domain: domain || null, outcome });

    try {
      if (!domain || !domain.includes(".")) {
        /* decideProvisioning refuses a nameless domain order, so this should be
           unreachable. Handled anyway: a queued row nobody can drain is worse
           than a failed one, because it sits in the desk's list looking like work. */
        await markProvisioningFailed(r.id, "No domain name on the order — nothing can be registered.");
        result.failed++; note("no-domain");
        continue;
      }

      /* The buyer. A domain must belong to a customer; without one there is no
         asset row that anybody could ever be shown. */
      const { data: quote } = await admin
        .from("quotes")
        .select("customer_id, customer_name")
        .eq("id", r.quote_id)
        .maybeSingle();

      if (!quote?.customer_id) {
        await markProvisioningFailed(
          r.id,
          "The paid quote has no customer on it, so the registration has no owner to file it under. Attach the customer to the quote and release this again.",
        );
        result.failed++; note("no-customer");
        continue;
      }

      const tld = domain.slice(domain.indexOf(".") + 1);
      const years = 1;

      /* ── Claim before calling (rule 2) ───────────────────────────────────
         The insert IS the claim: `domains_name_unique` is a global unique
         index, so a second worker reaching this line for the same name loses
         the insert and skips. Cheaper and more honest than a lock column,
         because the row we need to write anyway is the thing doing the
         excluding. `processing_until` marks it in flight for the sweep. */
      const claimedUntil = new Date(Date.now() + 10 * 60_000).toISOString();
      const { data: claimed, error: claimErr } = await admin
        .from("domains")
        .insert({
          tenant_id: r.tenant_id,
          customer_id: quote.customer_id,
          domain_name: domain,
          tld,
          status: "pending",
          registration_years: years,
          quote_id: r.quote_id,
          provisioning_request_id: r.id,
          amount_paid: r.amount_paid,
          processing_until: claimedUntil,
          /* The contact this is filed under at ResellerClub. `registrar_order_id`,
             `registered_at` and `expires_at` are deliberately absent — they do not
             exist until RC answers, and writing them as null here would only
             restate what the column default already says. */
          registrar_customer_id: RC_CUSTOMER_ID,
          registrar_contact_id: RC_CONTACT_ID,
        })
        .select("id")
        .maybeSingle();

      if (claimErr || !claimed) {
        /* Almost always the unique index: another worker has it, or the name is
           already ours from an earlier run. Either way this run must not order. */
        console.warn(`[provision-domain] could not claim ${domain}: ${claimErr?.message ?? "no row"}`);
        result.pending++; note("pending-upstream");
        continue;
      }

      /* ── The irreversible bit ─────────────────────────────────────────── */
      const outcome = await rcRegisterDomain({
        domainName: domain,
        years,
        customerId: RC_CUSTOMER_ID,
        contactId: RC_CONTACT_ID,
      });

      if (outcome.kind === "hard_failure") {
        /* Definitely did not happen — safe to say so and safe to try again
           later. The asset row is kept (not deleted) carrying the reason, so
           the desk can see the attempt; it is marked failed so it is not
           mistaken for a live domain. */
        await admin.from("domains").update({
          status: "failed",
          processing_until: null,
          last_error: outcome.reason,
          last_error_at: new Date().toISOString(),
        }).eq("id", claimed.id);
        await markProvisioningFailed(r.id, `ResellerClub refused the registration: ${outcome.reason}`);

        const { alert: owner } = await loadOwnerAlert(admin, r.tenant_id);
        if (owner.ok) {
          await sendEmail({
            to: owner.to, from: FROM_EMAIL, kind: "razorpay_payment_owner", route: { tenantId: r.tenant_id },
            subject: `⚠️ Domain registration failed — ${domain}`,
            text: `A paid order for ${domain} (${r.quote_id}, ${quote.customer_name ?? "customer"}) could not be registered:\n\n  ${outcome.reason}\n\nThe money HAS been taken. Register it by hand or refund.\n${APP_URL}/quotes/${r.quote_id}`,
          }).catch(() => {});
        }
        result.failed++; note("failed");
        continue;
      }

      if (mustNotRetry(outcome) && outcome.kind !== "registered_no_order_id") {
        /* balance_pending / already_in_progress — it may still land upstream.
           Leave the provisioning request QUEUED so the next run re-checks by
           name; do NOT mark it failed, because failed rows get retried by hand
           and that is how a name gets bought twice. */
        await admin.from("domains").update({
          processing_until: null,
          last_error: `ResellerClub has not completed this yet (${outcome.kind}) — re-checking, not re-ordering`,
          last_error_at: new Date().toISOString(),
          next_action_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        }).eq("id", claimed.id);
        result.pending++; note("pending-upstream");
        continue;
      }

      /* Registered. Recover the order id if RC did not hand one back (rule 3). */
      let orderId: string | null = outcome.kind === "registered" ? outcome.orderId : null;
      if (!orderId) {
        const lookup = await rcOrderIdFor(domain);
        if (lookup.kind === "found") orderId = lookup.value;
      }

      /* The registrar's expiry, which is the date the portal shows and the value
         a future renewal must send back. Read rather than computed: "today plus
         a year" is a guess, and a guess here renews the wrong domain-year. */
      let expiresAt: string | null = null;
      if (orderId) {
        const details = await rcDomainDetails(domain);
        if (details.kind === "found" && details.value.expiryEpochSeconds) {
          expiresAt = new Date(details.value.expiryEpochSeconds * 1000).toISOString();
        }
      }

      await admin.from("domains").update({
        /* No order id means we cannot act on it later, so it is not `active`
           yet — the sweep will finish the job. */
        status: orderId ? "active" : "pending",
        registrar_order_id: orderId,
        registered_at: new Date().toISOString(),
        expires_at: expiresAt,
        processing_until: null,
        last_error: orderId ? null : "Registered at ResellerClub but no order id yet — looking it up",
        last_error_at: orderId ? null : new Date().toISOString(),
        last_synced_at: new Date().toISOString(),
      }).eq("id", claimed.id);

      if (orderId) {
        await markProvisioningActivated(r.id, orderId);
        result.registered++; note("registered");
      } else {
        result.pending++; note("pending-upstream");
      }
    } catch (e) {
      /* A crash here is the dangerous case: the order may have gone through. It
         is recorded as a crash and left QUEUED so a human looks, rather than
         auto-retried. */
      console.error(`[provision-domain] ${domain || r.quote_id} crashed:`, (e as Error).message);
      try {
        /* Best-effort — if this write also fails there is nothing further to do
           here, and swallowing it must not cost us the loop's remaining rows. */
        await admin.from("domains").update({
          processing_until: null,
          last_error: `Worker crashed mid-registration: ${(e as Error).message}. Check ResellerClub before retrying.`,
          last_error_at: new Date().toISOString(),
        }).eq("quote_id", r.quote_id).eq("domain_name", domain);
      } catch { /* nothing left to try */ }
      result.failed++; note("crash");
    }
  }

  return NextResponse.json(result);
}
