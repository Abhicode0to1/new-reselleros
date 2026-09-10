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
import { decideRegistrationRetry } from "@/lib/domains/retry";
import { rcEnsureRegistrant } from "@/lib/resellerclub/customers";
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

/* "registrant-unresolved" is kept apart from "failed" on purpose: it means the order
   never reached ResellerClub, usually because the customer record is missing an
   address the registry requires. Different queue, different fix. */
type Outcome = "registered" | "pending-upstream" | "failed" | "no-domain" | "no-customer" | "registrant-unresolved" | "crash";

async function handle(req: Request) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!rcOrderingEnabled()) {
    return NextResponse.json({
      ran: true,
      registered: 0,
      note: "domain ordering is not live in this environment (RESELLERCLUB credentials / DOMAIN_REGISTER_LIVE=1)",
    });
  }
  /* RESELLERCLUB_CUSTOMER_ID / RESELLERCLUB_CONTACT_ID are an OVERRIDE now, not a
     precondition. This used to refuse the whole run unless both were set by hand, and
     refusing was right at the time: RC files a registration against a customer and a
     contact, and sending the wrong ones puts the domain in somebody else's account. But
     ONE pair of env ids means every customer's domain is filed under the same registrant,
     which is the same defect wearing a different hat. Since 9 Sep each order resolves its
     OWN registrant from the customer record (lib/resellerclub/customers.ts). The env pair
     still wins when it is set, for a single-account reseller who wants exactly that. */

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
          /* Left null unless the env override is set — the per-customer identity is
             resolved AFTER the claim (see below) and stamped on then. Claiming first
             keeps a lost race from creating an RC contact nobody needed. */
          registrar_customer_id: RC_CUSTOMER_ID || null,
          registrar_contact_id: RC_CONTACT_ID || null,
          /* The claim IS the attempt — everything below this line either orders or
             records why it could not, so counting here cannot under-count. */
          attempt_count: 1,
          last_attempt_at: new Date().toISOString(),
        })
        .select("id")
        .maybeSingle();

      let claimedId = claimed?.id ?? null;

      if (!claimedId) {
        /* The insert lost. Two very different reasons, and telling them apart is
           the whole of the retry feature (lib/domains/retry.ts):

           · another worker holds it, or it is already ours and live — this run
             must not order, and must not touch the row;
           · it is OUR OWN earlier FAILED attempt at a domain the customer has
             already paid for. Almost always an empty ResellerClub wallet, which
             fixes itself the moment somebody tops up. That is worth re-ordering,
             a bounded number of times, on a backoff.

           Before 10 Sep the second case was left for somebody to retry by hand,
           which is a thing nobody does at 2am. */
        const { data: existing } = await admin
          .from("domains")
          .select("id, status, attempt_count, last_attempt_at, resolved_at, tenant_id")
          .eq("domain_name", domain)
          .is("deleted_at", null)
          .maybeSingle();

        const decision = existing
          ? decideRegistrationRetry({
              status: existing.status,
              attemptCount: existing.attempt_count ?? 0,
              lastAttemptAt: existing.last_attempt_at,
              resolvedAt: existing.resolved_at,
            })
          : null;

        if (!existing || !decision || decision.kind !== "retry") {
          console.warn(
            `[provision-domain] not claiming ${domain}: ${claimErr?.message ?? "insert lost"}` +
            (decision ? ` — ${decision.kind}: ${"reason" in decision ? decision.reason : ""}` : ""),
          );
          result.pending++; note("pending-upstream");
          continue;
        }

        /* Re-claim our own failed row. `.eq("status", "failed")` in the update is
           the lock: if another worker got here first the row is no longer failed,
           this update matches nothing, and we skip rather than double-order. */
        const nextAttempt = (existing.attempt_count ?? 0) + 1;
        const { data: reclaimed } = await admin
          .from("domains")
          .update({
            status: "pending",
            processing_until: claimedUntil,
            attempt_count: nextAttempt,
            last_attempt_at: new Date().toISOString(),
            /* Cleared because this attempt is about to write its own outcome.
               Leaving the old reason would make a fresh failure look stale. */
            last_error: null,
            last_error_at: null,
          })
          .eq("id", existing.id)
          .eq("status", "failed")
          .select("id")
          .maybeSingle();

        if (!reclaimed) {
          console.warn(`[provision-domain] ${domain}: another worker took the retry`);
          result.pending++; note("pending-upstream");
          continue;
        }
        console.log(`[provision-domain] retrying ${domain}, attempt ${nextAttempt}`);
        claimedId = reclaimed.id;
      }

      /* Both paths above either set this or `continue`d, so it is a string from
         here on — said once rather than asserted at each of the five uses. */
      const domainRowId: string = claimedId;

      /* ── Who the domain is filed under ───────────────────────────────────
         After the claim, before the order. A registrant is reusable and cheap; a
         registration is neither, so the identity is settled while nothing is
         irreversible yet. */
      let filedUnder = { customerId: RC_CUSTOMER_ID, contactId: RC_CONTACT_ID };

      if (!RC_CUSTOMER_ID || !RC_CONTACT_ID) {
        const { data: buyer } = await admin
          .from("customers")
          .select("name, contact_email, contact_phone, address, city, state, pin_code")
          .eq("id", quote.customer_id)
          .maybeSingle();

        const identity = await rcEnsureRegistrant({
          email: buyer?.contact_email ?? "",
          name: buyer?.name ?? quote.customer_name ?? "",
          companyName: buyer?.name ?? null,
          phone: buyer?.contact_phone ?? "",
          address: {
            line1: buyer?.address ?? "",
            city: buyer?.city ?? "",
            state: buyer?.state ?? "",
            zipcode: buyer?.pin_code ?? "",
          },
        });

        if (identity.kind !== "ready") {
          /* Nothing was ordered, so the claim is released rather than left to the
             sweep — the name stays available and the desk gets the reason. A
             `refused` is a data problem (an incomplete customer record) and retrying
             it unchanged cannot help, which is why the message says what to fix. */
          await admin.from("domains").update({
            status: "failed",
            processing_until: null,
            last_error: identity.reason,
            last_error_at: new Date().toISOString(),
          }).eq("id", domainRowId);
          await markProvisioningFailed(r.id, `Could not establish the registrant at ResellerClub: ${identity.reason}`);
          result.failed++; note("registrant-unresolved");
          continue;
        }

        filedUnder = { customerId: identity.customerId, contactId: identity.contactId };

        /* Stamped before the order, so a crash between here and RC still leaves a row
           saying which registrant the attempt used. */
        await admin.from("domains").update({
          registrar_customer_id: identity.customerId,
          registrar_contact_id: identity.contactId,
        }).eq("id", domainRowId);
      }

      /* ── The irreversible bit ─────────────────────────────────────────── */
      const outcome = await rcRegisterDomain({
        domainName: domain,
        years,
        customerId: filedUnder.customerId,
        contactId: filedUnder.contactId,
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
        }).eq("id", domainRowId);
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
        }).eq("id", domainRowId);
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
      }).eq("id", domainRowId);

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
