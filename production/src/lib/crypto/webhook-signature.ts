/**
 * Webhook signature verification — pure, so the security decision is testable
 * without standing up a route.
 *
 * WHY THIS EXISTS. The WhatsApp webhook verified its HMAC only when an app
 * secret happened to be stored:
 *
 *     if (secrets?.whatsapp_app_secret) { ...verify, else 401... }
 *
 * With no secret configured that check was skipped entirely and the payload was
 * processed. Production has no `whatsapp_app_secret` set, so the endpoint was
 * accepting unsigned POSTs: anyone who knew the URL and a tenant id could inject
 * inbound "messages" into that tenant's inbox, which the app turns into contacts,
 * conversations and lead activity.
 *
 * The Razorpay webhook already got this right — no secret means no request can
 * ever be trusted, so it refuses. This brings WhatsApp to the same rule and puts
 * the decision somewhere it can be proved rather than read.
 *
 * FAIL CLOSED IS NOT A PREFERENCE HERE. An unverified webhook is not "less
 * secure", it is unauthenticated remote write access. Refusing costs a
 * configuration step; allowing costs whatever an attacker chooses to send.
 */
import crypto from "node:crypto";

export type SignatureVerdict =
  | { ok: true }
  /** No secret configured — nothing can be verified, so nothing is trusted. */
  | { ok: false; reason: "not_configured" }
  | { ok: false; reason: "missing_header" }
  | { ok: false; reason: "mismatch" };

/** Constant-time compare that tolerates differing lengths without throwing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on length mismatch. Comparing lengths first leaks
  // only the length, which the attacker already controls, and a differing
  // length is always a mismatch.
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}

/**
 * Verify Meta's `x-hub-signature-256` header: `sha256=<hex of HMAC(body)>`.
 *
 * The HMAC covers the RAW body, so callers must pass the exact bytes received —
 * re-serialising parsed JSON changes whitespace and key order and will never match.
 */
export function verifyMetaSignature(
  rawBody: string,
  header: string | null | undefined,
  appSecret: string | null | undefined,
): SignatureVerdict {
  const secret = appSecret?.trim();
  if (!secret) return { ok: false, reason: "not_configured" };

  const sig = header?.trim();
  if (!sig) return { ok: false, reason: "missing_header" };

  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(sig, expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** Operator-facing explanation for a refusal — logged, never returned to the caller. */
export function signatureRefusalReason(reason: Exclude<SignatureVerdict, { ok: true }>["reason"]): string {
  switch (reason) {
    case "not_configured":
      return "no app secret stored for this tenant — every request is refused until one is saved, " +
             "because an unverified webhook is unauthenticated write access, not merely a weaker check";
    case "missing_header":
      return "request carried no x-hub-signature-256 header";
    case "mismatch":
      return "signature did not match the body — either the secret is wrong or the payload was altered";
  }
}
