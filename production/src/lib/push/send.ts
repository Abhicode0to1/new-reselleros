/**
 * Send a Web Push to people. Server-only.
 *
 * ─── WHY web-push AND NOT HAND-ROLLED ───────────────────────────────────────
 * Web Push is not "POST a JSON body". Every message is encrypted to the device's own
 * public key (RFC 8291: ECDH → HKDF → AES128GCM) and signed as a VAPID JWT (RFC 8292).
 * Writing that by hand is writing crypto by hand, which is the one thing this codebase
 * should never do. `web-push` is the reference implementation and is what Google's own
 * docs use. That is the justification CLAUDE.md asks for before a dependency lands.
 *
 * ─── A MISSING KEY MUST NOT BREAK THE CALLER ────────────────────────────────
 * Push is a courtesy channel bolted onto real work: a cron that also sends email, a
 * payment that was already recorded. If VAPID keys are absent — a fresh checkout, a
 * deploy where the env var was forgotten — this returns a "not configured" result and
 * logs it. It never throws. A notification failing must not roll back a payment.
 *
 * ─── AND THE FAILURE IT WOULD BE EASY TO GET WRONG ──────────────────────────
 * Pruning. 404/410 means that device is gone for good and the row must go, or every
 * later send retries garbage. 401/403 means OUR key is wrong and EVERY device fails at
 * once — deleting on those would wipe the whole table on one bad deploy. The decision
 * lives in payload.ts with tests, not in the middle of this loop.
 */
import webpush from "web-push";
import { createAdminClient } from "@/lib/supabase/server";
import {
  pushPayload, categoryFor, deviceWants, dispositionForStatus,
  type PushEvent,
} from "./payload";

export interface PushResult {
  /** Devices that were asked to receive this — before any of them succeeded or failed.
      Reported separately because "nothing was sent" and "nothing is registered" are
      different facts, and a caller that cannot tell them apart tells the operator to fix
      the wrong thing. */
  attempted: number;
  failed: number;
  sent: number;
  /** Devices that had not consented to this category. Not a failure. */
  skippedByConsent: number;
  /** Dead endpoints removed (404/410). */
  pruned: number;
  /** Set when VAPID is not configured, or the key is rejected. */
  problem?: string;
}

let configured: boolean | null = null;

/** Configure once per process. Returns false when the keys are absent. */
function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim() || "mailto:support@anutech.in";
  if (!publicKey || !privateKey) {
    configured = false;
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  categories: string[] | null;
}

/**
 * Push one event to a set of users' devices.
 *
 * `userIds` is explicit rather than "everyone in the tenant" on purpose: every caller
 * should have to say who it is interrupting. A broadcast is a decision, not a default.
 */
export async function sendPushToUsers(userIds: readonly string[], event: PushEvent): Promise<PushResult> {
  const result: PushResult = { attempted: 0, failed: 0, sent: 0, skippedByConsent: 0, pruned: 0 };
  if (userIds.length === 0) return result;

  if (!ensureConfigured()) {
    /* Loud in the log, harmless to the caller. Silence here would make a forgotten env
       var indistinguishable from "nobody has notifications on". */
    console.warn("[push] VAPID keys are not configured — no notification was sent");
    return { ...result, problem: "not-configured" };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth, categories")
    .in("user_id", userIds as string[]);

  if (error) {
    console.error("[push] could not read subscriptions:", error.message);
    return { ...result, problem: "subscription-read-failed" };
  }

  const category = categoryFor(event);
  const payload = JSON.stringify(pushPayload(event));
  const deadIds: string[] = [];

  for (const sub of (data ?? []) as SubscriptionRow[]) {
    if (!deviceWants(sub.categories, category)) {
      result.skippedByConsent += 1;
      continue;
    }
    result.attempted += 1;
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      result.sent += 1;
    } catch (err) {
      result.failed += 1;
      const status = Number((err as { statusCode?: number }).statusCode ?? 0);
      const disposition = dispositionForStatus(status);
      if (disposition === "delete") {
        deadIds.push(sub.id);
      } else if (disposition === "config-error") {
        /* Every device will fail the same way, so say it once and stop guessing. */
        result.problem = `vapid-rejected-${status}`;
        console.error("[push] the push service rejected our VAPID key — check VAPID_PRIVATE_KEY");
        break;
      } else {
        await admin
          .from("push_subscriptions")
          .update({ failed_at: new Date().toISOString(), failure_reason: `status ${status}` })
          .eq("id", sub.id);
      }
    }
  }

  if (deadIds.length > 0) {
    const { error: delErr } = await admin.from("push_subscriptions").delete().in("id", deadIds);
    if (delErr) console.error("[push] could not prune dead subscriptions:", delErr.message);
    else result.pruned = deadIds.length;
  }

  if (result.sent > 0) {
    await admin
      .from("push_subscriptions")
      .update({ last_used_at: new Date().toISOString(), failed_at: null, failure_reason: null })
      .in("user_id", userIds as string[]);
  }

  return result;
}
