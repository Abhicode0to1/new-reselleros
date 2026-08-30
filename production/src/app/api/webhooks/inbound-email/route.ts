/**
 * POST /api/webhooks/inbound-email — the public door.
 *
 * This file is now ONLY the door: verify the shared secret, parse the JSON, hand the body
 * to `lib/inbound/ingest.ts`. Everything the pipeline does — normalise, route, classify,
 * create or append to a lead, notify — lives there and is unchanged.
 *
 * ─── WHY IT WAS SPLIT (30 Aug 2026) ─────────────────────────────────────────
 * The app started reading `sales@anutech.in` itself through the Gmail connector
 * (`/api/cron/gmail-inbox`), because the Apps Script forwarder standing in front of this
 * webhook had failed silently: a stale copy of the script, posting an old `?key=` secret
 * that matches nothing Cloud Run accepts, 401 on every run, and not one enquiry reaching
 * the app for two days while the mail sat labelled `erp-sent` as though it were delivered.
 *
 * So this logic acquired a second caller, and a route file may export only route handlers —
 * Next.js rejects anything else with TS2344. The pipeline had to move out. It moved whole,
 * not copied: the same argument `lib/ai/read-bill.ts` makes about a copied prompt applies
 * harder here, because these branches create leads, quotes and tasks.
 *
 * Public route — the secret is the only guard (mirrors the Razorpay webhook's fail-closed
 * posture). The forwarder that POSTs here is being retired, but the endpoint stays: it is
 * how a second reseller's inbound-parse provider would deliver mail.
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  acceptedSecrets, secretMatches, readInboundSecret, querySecretAllowed, querySecretWarning,
} from "@/lib/inbound/verify-secret";
import { ingestInboundEmail } from "@/lib/inbound/ingest";

/* May hold SEVERAL secrets, comma-separated, so the value can be rotated without a window
   in which the forwarder is refused — see lib/inbound/verify-secret.ts for why a window here
   loses mail rather than merely failing requests. */
const INBOUND_SECRET = process.env.INBOUND_EMAIL_SECRET?.trim() || "";

export async function POST(request: NextRequest) {
  // ── 1. Secret guard (fail closed) ──────────────────────────────────────
  /* Header pehle, query baad me — aur query aane par LOG me chetavni, kyunki Cloud Run
     poora URL `httpRequest.requestUrl` me likhta hai aur secret wahan cleartext baith jata
     hai. Faisla lib/inbound/verify-secret.ts me hai, teeno route ke liye ek hi jagah.

     A LIST, so the secret can be rotated with no window. `INBOUND_EMAIL_SECRET` accepts
     "old,new" — set that, update the forwarder, then drop the old one.

     Still fails closed on an empty value, and compares in constant time. */
  const secret = readInboundSecret(request);
  if (secret.fromQuery && !querySecretAllowed()) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!secretMatches(secret.value, acceptedSecrets(INBOUND_SECRET))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  /* Sahi secret ke BAAD, taaki galat key thokne wala apne aap log na bhar sake. */
  if (secret.fromQuery) console.warn(querySecretWarning("webhooks/inbound-email"));

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  return ingestInboundEmail(body);
}
