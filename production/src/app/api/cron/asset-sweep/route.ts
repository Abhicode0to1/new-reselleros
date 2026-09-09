/**
 * Keep the domain and hosting asset rows in step with what is actually true.
 *
 * ─── WHAT WAS WRONG WITHOUT THIS ─────────────────────────────────────────────
 * `domains.expires_at` was written exactly once, by `provision-domain`, at the
 * moment of registration — and never again. The migration added
 * `next_action_at` and `processing_until` for a sweep that did not exist yet, so
 * the portal's "12d left" was true on the day of purchase and drifted from the
 * next morning on. A domain renewed at the registrar kept its old date; an
 * expired one still read "Active". A system of record with nothing keeping the
 * record current is a system of stale record.
 *
 * ─── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 * IT NEVER SPENDS MONEY. It does not file renewals, and that is not an omission
 * to fill in later without thinking: there is no stored card (migration 0063's
 * decision, which is also why /portal/domains has no auto-renew toggle), so
 * "renew automatically" would promise a charge that cannot happen. The upstream
 * renewal belongs on the path where the money has ALREADY been collected. This
 * sweep reconciles truth and raises signals; every rupee-spending action stays
 * behind `rcOrderingEnabled()` elsewhere.
 *
 * That is also why it works with the money gate shut: `rcDomainDetails` is a
 * read and needs only credentials, so the sweep is useful in an environment
 * where DOMAIN_REGISTER_LIVE is deliberately 0.
 *
 * ─── THE RULE THE WHOLE FILE OBEYS ───────────────────────────────────────────
 * A FAILED READ IS NOT A LIFECYCLE EVENT. If ResellerClub times out, rejects our
 * IP, or answers something unmapped, the row is left exactly as it was and the
 * reason is recorded. Nothing here writes a status from an absence of
 * information — the arithmetic in `lib/domains/lifecycle.ts` returns null for
 * "leave it alone", and this route honours that.
 *
 * Not-found gets the same treatment for a sharper reason: RC reporting no order
 * for a domain COULD mean it was transferred away, and it could equally mean a
 * bad lookup. Marking a customer's live domain `transferred_out` on that
 * evidence is the worst output this file could produce, so it records the reason,
 * backs off, and leaves the decision to a person.
 */
import { NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { rcDomainDetails } from "@/lib/resellerclub/orders";
import { rcWriteConfigured } from "@/lib/resellerclub/call";
import {
  deriveDomainStatus,
  nextDomainCheckAt,
  deriveHostingStatus,
  expiryDisagreementDays,
  disagreementIsWorthFlagging,
} from "@/lib/domains/lifecycle";
import type { DomainAssetStatus, HostingAccountStatus, DomainRow } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** One claim lasts this long. Long enough for RC to answer, short enough that a
 *  torn-down Cloud Run instance does not strand a row for hours. */
const CLAIM_MINUTES = 10;

/** Per run. The sweep is idempotent and re-entrant, so a backlog drains over
 *  several runs rather than one long request that Cloud Run may cut off. */
const DOMAIN_BATCH = 40;
const HOSTING_BATCH = 100;

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

type DomainOutcome = "reconciled" | "unchanged" | "unreadable" | "unclaimed-upstream" | "lock-lost";

async function handle(req: Request) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const now = new Date();
  const nowIso = now.toISOString();

  const result = {
    ran_at: nowIso,
    domains: { due: 0, reconciled: 0, unchanged: 0, unreadable: 0, unclaimed_upstream: 0, lock_lost: 0 },
    hosting: { checked: 0, expired: 0 },
    /* Surfaced, never repaired — see lifecycle.ts. */
    billing_disagreements: [] as Array<{ domain: string; registrar_expiry: string | null; billing_renewal: string | null; days_apart: number }>,
    details: [] as Array<{ domain: string; outcome: DomainOutcome; from?: string; to?: string; note?: string }>,
    skipped: null as string | null,
  };

  /* ── Domains ──────────────────────────────────────────────────────────────── */

  if (!rcWriteConfigured()) {
    /* No credentials means no upstream truth to fetch. Say so rather than
       running the date arithmetic against stale expiries and calling that a
       reconcile — the dates we hold are exactly what is in doubt. */
    result.skipped = "ResellerClub credentials are not configured — domain reconciliation needs them (hosting still swept)";
  } else {
    const { data: due, error: dueErr } = await admin
      .from("domains")
      .select("id, domain_name, status, expires_at, subscription_id, next_action_at")
      .is("deleted_at", null)
      .in("status", ["pending", "active", "expiring_soon", "grace", "redemption", "suspended"])
      .or(`next_action_at.is.null,next_action_at.lte.${nowIso}`)
      .or(`processing_until.is.null,processing_until.lte.${nowIso}`)
      .order("next_action_at", { ascending: true, nullsFirst: true })
      .limit(DOMAIN_BATCH);

    if (dueErr) {
      console.error("[asset-sweep] listing due domains failed:", dueErr.message);
      return NextResponse.json({ ...result, error: "could not list due domains" }, { status: 500 });
    }

    result.domains.due = (due ?? []).length;

    for (const row of due ?? []) {
      const note = (outcome: DomainOutcome, extra?: Partial<{ from: string; to: string; note: string }>) =>
        result.details.push({ domain: row.domain_name, outcome, ...extra });

      /* The claim IS an update, conditional on the lock still being free. If it
         writes no row another worker got there first — the pattern exists
         because two Cloud Run instances once renewed the same domain twice. */
      const claimedUntil = new Date(now.getTime() + CLAIM_MINUTES * 60_000).toISOString();
      const { data: claimed } = await admin
        .from("domains")
        .update({ processing_until: claimedUntil })
        .eq("id", row.id)
        .or(`processing_until.is.null,processing_until.lte.${nowIso}`)
        .select("id")
        .maybeSingle();

      if (!claimed) {
        result.domains.lock_lost++; note("lock-lost");
        continue;
      }

      const look = await rcDomainDetails(row.domain_name);

      if (look.kind === "hard_failure" || look.kind === "not_found") {
        /* Neither answer is permission to change what the customer sees. */
        const unclaimed = look.kind === "not_found";
        await admin.from("domains").update({
          processing_until: null,
          /* Back off a day; a not-found is not going to resolve itself in an hour. */
          next_action_at: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
          last_error: unclaimed
            ? `ResellerClub reports no order for this domain (${look.reason}). It may have been transferred away or deleted upstream — the status is deliberately left unchanged for a person to confirm.`
            : look.reason,
          last_error_at: nowIso,
        }).eq("id", row.id);

        if (unclaimed) { result.domains.unclaimed_upstream++; note("unclaimed-upstream", { note: look.reason }); }
        else { result.domains.unreadable++; note("unreadable", { note: look.reason }); }
        continue;
      }

      const rc = look.value;
      const expiresAt = rc.expiryEpochSeconds ? new Date(rc.expiryEpochSeconds * 1000).toISOString() : null;
      const nextStatus = deriveDomainStatus({
        current: row.status as DomainAssetStatus,
        registrarStatus: rc.status,
        expiresAt,
        now,
      });

      const effectiveStatus = (nextStatus ?? row.status) as DomainAssetStatus;
      /* Typed against the row rather than a loose record, so a renamed column is a
         compile error here instead of an update that silently writes nothing. */
      const patch: Partial<DomainRow> = {
        processing_until: null,
        next_action_at: nextDomainCheckAt({ status: effectiveStatus, expiresAt, now }),
        /* The read worked, so whatever the last failure was is history. */
        last_error: null,
        last_error_at: null,
      };
      if (expiresAt) patch.expires_at = expiresAt;
      if (rc.orderId) patch.registrar_order_id = rc.orderId;
      if (rc.nameservers.length > 0) patch.nameservers = rc.nameservers;
      if (rc.privacyProtection !== null) patch.privacy_protection = rc.privacyProtection;
      if (rc.transferLock !== null) patch.transfer_lock = rc.transferLock;
      if (nextStatus) patch.status = nextStatus;

      await admin.from("domains").update(patch).eq("id", row.id);

      if (nextStatus) { result.domains.reconciled++; note("reconciled", { from: row.status, to: nextStatus }); }
      else { result.domains.unchanged++; result.domains.reconciled += 0; }

      /* The disagreement the schema was designed to show. Reported, not repaired:
         either side could be the wrong one, and a domain renewed for two years
         upstream while billing expects twelve months is a pricing conversation. */
      if (row.subscription_id && expiresAt) {
        const { data: sub } = await admin
          .from("subscriptions")
          .select("renewal_date")
          .eq("id", row.subscription_id)
          .maybeSingle();
        const daysApart = expiryDisagreementDays(expiresAt, sub?.renewal_date ?? null);
        if (disagreementIsWorthFlagging(daysApart)) {
          result.billing_disagreements.push({
            domain: row.domain_name,
            registrar_expiry: expiresAt,
            billing_renewal: sub?.renewal_date ?? null,
            days_apart: daysApart as number,
          });
        }
      }
    }
  }

  /* ── Hosting ──────────────────────────────────────────────────────────────── */

  /* Date arithmetic only, and the limitation is real: there is no DirectAdmin
     read in this app that reports an account's expiry, so unlike a domain there
     is no upstream truth to reconcile against. What this does catch is an ended
     trial still displaying as a live account. */
  const { data: hosts } = await admin
    .from("hosting_accounts")
    .select("id, domain_name, status, is_trial, trial_ends_at, expires_at")
    .is("deleted_at", null)
    .in("status", ["active", "expired"])
    .limit(HOSTING_BATCH);

  for (const h of hosts ?? []) {
    result.hosting.checked++;
    const next = deriveHostingStatus({
      current: h.status as HostingAccountStatus,
      isTrial: !!h.is_trial,
      trialEndsAt: h.trial_ends_at,
      expiresAt: h.expires_at,
      now,
    });
    if (!next) continue;
    await admin.from("hosting_accounts").update({ status: next }).eq("id", h.id);
    if (next === "expired") result.hosting.expired++;
  }

  return NextResponse.json({ ran: true, ...result });
}
