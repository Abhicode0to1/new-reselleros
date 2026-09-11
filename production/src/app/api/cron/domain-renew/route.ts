/**
 * GET|POST /api/cron/domain-renew — file a PAID renewal at the registrar.
 *
 * Schedule: every 30 minutes. This is the only thing in the app that calls
 * `rcRenewDomain`, which has existed since the 9 Sep 2026 port with no caller
 * anywhere — so until now a customer could be warned, quoted and charged for a
 * renewal and nothing would ever file it.
 *
 *   /api/cron/domain-expiry          warns, carries no price
 *   /api/domains/:id/renewal-quote   the reseller raises the priced quote
 *   the customer pays                (ordinary quote flow, unchanged)
 *   → THIS ROUTE                     files it at ResellerClub
 *
 * ─── IT SPENDS REAL MONEY, SO EVERY GUARD IS SOMEWHERE ELSE AND TESTED ──────
 * `decideRenewalFiling` in `lib/domains/renewal-filing.ts` decides, with 28
 * tests and six killed mutations. This route only dispatches. The three
 * expensive mistakes it exists to prevent:
 *
 *   · filing against a quote nobody paid — the reseller buying a customer a year
 *   · filing twice — a renewal that landed but was not recorded, re-filed at
 *     full price
 *   · filing on a term the registrar disagrees with — the customer paying for
 *     one thing and getting another
 *
 * ─── THE LIVE EXPIRY IS READ IMMEDIATELY BEFORE FILING ──────────────────────
 * Not taken from our row. `rcRenewDomain` requires `exp-date` and ResellerClub
 * uses it to reject a duplicate, which only works if the value we send is the one
 * the registrar currently holds. So every attempt does a fresh `rcDomainDetails`
 * first, and the decision compares that against the term the renewal was quoted
 * against. A domain whose expiry has already moved on is recorded as renewed
 * WITHOUT a second call.
 *
 * ─── THE GATE, AND WHAT IT DOES WHEN SHUT ───────────────────────────────────
 * `rcRenewDomain` refuses unless credentials are present AND
 * `DOMAIN_REGISTER_LIVE=1`. With the gate shut this route writes nothing and
 * leaves the row queued, saying so in the run — the same discipline as
 * hosting-suspend with DirectAdmin unconfigured. Clearing the queue would erase
 * the only durable record that a paid renewal still has to be filed, and the
 * customer's domain would lapse with the books saying it was renewed.
 *
 * ─── WHAT IS NOT VERIFIED, SAID PLAINLY ─────────────────────────────────────
 * A SUCCESSFUL renewal has never been observed. No domain in this database has a
 * `registrar_order_id`, because none was registered through ResellerClub yet, and
 * the money gate is off. The refusal paths, the money gate, the duplicate guard
 * and the gate-shut behaviour are all verified; the happy path is reasoned from
 * `rcRenewDomain`'s own typed outcomes and will need one real renewal watched
 * before anybody should trust it.
 */
import { NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { rcDomainDetails, rcRenewDomain } from "@/lib/resellerclub/orders";
import { rcOrderingEnabled, rcWriteConfigured } from "@/lib/resellerclub/call";
import { decideRenewalFiling, type QuotePaymentState } from "@/lib/domains/renewal-filing";
/* Borrowed from the hosting side, and the name is worse than the code: that
   module is a retry table (15m / 1h / 4h / daily) with tests, and the shape of
   "an upstream is refusing us, stop hammering it" is identical here. A second
   copy of the same four numbers would be a second thing to get wrong. */
import { nextSuspendAttemptAt } from "@/lib/hosting/suspend-backoff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Per run. Each item is a live, irreversible call that costs money. */
const BATCH = 10;

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

async function handle(req: Request): Promise<NextResponse> {
  if (!(await authorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const admin = createAdminClient();

  const result = {
    ran_at: nowIso,
    due: 0,
    filed: 0,
    /** Already renewed at the registrar — recorded, not re-filed. */
    already_renewed: 0,
    waiting: 0,
    refused: [] as Array<{ domain: string; reason: string; nextStep: string }>,
    failed: [] as Array<{ domain: string; reason: string }>,
    left_queued: 0,
    gate: "" as string,
  };

  const { data: due, error } = await admin
    .from("domain_renewals")
    .select("id, tenant_id, domain_id, domain_name, years, from_expires_at, quote_id, status, attempt_count")
    .eq("status", "quoted")
    .or(`next_action_at.is.null,next_action_at.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(BATCH);

  if (error) {
    console.error("[domain-renew] could not read the queue:", error.message);
    return NextResponse.json({ error: "could not read the queue" }, { status: 500 });
  }
  result.due = due?.length ?? 0;

  if (!rcOrderingEnabled()) {
    /* Nothing written and nothing cleared — see the header. The queue keeps its
       rows so this becomes a no-op the day the gate opens. */
    result.gate = rcWriteConfigured()
      ? "ResellerClub ordering is off (DOMAIN_REGISTER_LIVE is not 1) — nothing was filed and nothing was cleared"
      : "ResellerClub credentials are not configured — nothing was filed and nothing was cleared";
    result.left_queued = result.due;
    return NextResponse.json({ ran: true, ...result });
  }
  result.gate = "ResellerClub ordering is on";

  for (const row of due ?? []) {
    /* The money. Read fresh every time: a quote paid five minutes ago is the
       normal case for this job. */
    const { data: quote } = await admin
      .from("quotes")
      .select("payment_status")
      .eq("id", row.quote_id)
      .maybeSingle();

    /* ─── The registrar's CURRENT view, read before every attempt ──────────
         This is the duplicate guard's evidence. Cheap relative to what it
         prevents: a read before an irreversible purchase. */
    const details = await rcDomainDetails(row.domain_name);
    const live = details.kind === "found" ? details.value : null;

    const decision = decideRenewalFiling({
      renewalStatus: row.status as "quoted",
      quotePayment: (quote?.payment_status ?? null) as QuotePaymentState,
      years: row.years,
      fromExpiresAt: row.from_expires_at,
      liveExpiryEpochSeconds: live?.expiryEpochSeconds ?? null,
      liveOrderId: live?.orderId ?? null,
    });

    if (decision.action === "wait") {
      /* The ordinary case: nobody has paid yet. Not an error, not a retry
         schedule — the row stays exactly as it is and is looked at again next
         run. */
      result.waiting++;
      continue;
    }

    if (decision.action === "refuse") {
      /* A person has to look at it. Recorded on the row so it shows on the
         domain page, and the row stays `quoted` so it is not lost — but it backs
         off, because re-reading a registrar that is refusing us every half hour
         helps nobody. */
      const attempts = (row.attempt_count ?? 0) + 1;
      await admin
        .from("domain_renewals")
        .update({
          attempt_count: attempts,
          next_action_at: nextSuspendAttemptAt(attempts, now),
          last_error: `${decision.reason} ${decision.nextStep}`.slice(0, 500),
          last_error_at: nowIso,
        })
        .eq("id", row.id);
      result.refused.push({
        domain: row.domain_name,
        reason: decision.reason,
        nextStep: decision.nextStep,
      });
      continue;
    }

    if (decision.action === "already_renewed") {
      /* The registrar is ahead of us. Record it as renewed from THEIR date and
         do not call anything — this is the branch that stops a second purchase. */
      await admin
        .from("domain_renewals")
        .update({
          status: "renewed",
          renewed_at: nowIso,
          new_expires_at: live?.expiryEpochSeconds
            ? new Date(live.expiryEpochSeconds * 1000).toISOString().slice(0, 10)
            : null,
          registrar_order_id: live?.orderId ?? null,
          next_action_at: null,
          last_error: null,
          last_error_at: null,
        })
        .eq("id", row.id);

      if (live?.expiryEpochSeconds) {
        await admin
          .from("domains")
          .update({
            expires_at: new Date(live.expiryEpochSeconds * 1000).toISOString(),
            status: "active",
            last_synced_at: nowIso,
          })
          .eq("id", row.domain_id);
      }
      result.already_renewed++;
      continue;
    }

    // ── decision.action === "file": the irreversible call. ───────────────────
    const filed = await rcRenewDomain({
      orderId: live!.orderId!,
      years: decision.years,
      expiryEpochSeconds: decision.expiryEpochSeconds,
    });

    if (filed.kind !== "renewed") {
      /* `balance_pending` is the reseller's ResellerClub wallet being empty —
         the customer HAS paid us and we cannot pay the registrar. It backs off
         and shows on the domain page, because the fix is topping up a wallet and
         only a person can do that. */
      const attempts = (row.attempt_count ?? 0) + 1;
      const reason =
        filed.kind === "balance_pending"
          ? "ResellerClub refused it for want of funds — top up the reseller wallet. The customer has already paid us for this renewal."
          : filed.reason;
      await admin
        .from("domain_renewals")
        .update({
          attempt_count: attempts,
          next_action_at: nextSuspendAttemptAt(attempts, now),
          last_error: reason.slice(0, 500),
          last_error_at: nowIso,
        })
        .eq("id", row.id);
      console.error(`[domain-renew] ${row.domain_name}: ${reason}`);
      result.failed.push({ domain: row.domain_name, reason });
      continue;
    }

    /* ─── Filed. Now find out what the registrar actually gave us ───────────
       Re-read rather than computing `from + years`: registrars apply their own
       rules to grace-period renewals, and a computed date that disagrees with
       the registrar is the date somebody trusts a year from now. A failed
       re-read is NOT a failed renewal — the renewal happened — so the row is
       marked renewed either way and the date is left for the sweep. */
    const after = await rcDomainDetails(row.domain_name);
    const newExpiry =
      after.kind === "found" && after.value.expiryEpochSeconds
        ? new Date(after.value.expiryEpochSeconds * 1000).toISOString()
        : null;

    await admin
      .from("domain_renewals")
      .update({
        status: "renewed",
        renewed_at: nowIso,
        new_expires_at: newExpiry ? newExpiry.slice(0, 10) : null,
        registrar_order_id: live!.orderId,
        next_action_at: null,
        last_error: null,
        last_error_at: null,
      })
      .eq("id", row.id);

    await admin
      .from("domains")
      .update({
        ...(newExpiry ? { expires_at: newExpiry } : {}),
        status: "active",
        last_synced_at: nowIso,
      })
      .eq("id", row.domain_id);

    /* Durable audit. A renewal is money out of the reseller's wallet and a year
       of somebody's domain — worth a record six months later. `user_id` is null:
       no person pressed anything, the cron acted on a paid quote. */
    await admin.from("activity_log").insert({
      tenant_id: row.tenant_id,
      user_id: null,
      action: "domain.renewed",
      entity: "domain",
      entity_id: row.domain_id,
      label:
        `${row.domain_name} renewed for ${row.years} year${row.years > 1 ? "s" : ""} at the registrar ` +
        `against quote ${row.quote_id}` +
        (newExpiry ? `. New expiry ${newExpiry.slice(0, 10)}.` : ". The new expiry could not be read back."),
    });

    result.filed++;
  }

  return NextResponse.json({ ran: true, ...result });
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
