/**
 * Razorpay webhook self-test — proves the signature path works, without Razorpay.
 *
 * WHY THIS EXISTS. Production's webhook has never processed a single event: the
 * tenant has no `razorpay_webhook_secret`, so every delivery is answered 401.
 * The usual way to find out whether it works again after fixing that is to take
 * a real payment and see what happens — which is a terrible way to learn that
 * something is still wrong.
 *
 * This signs events exactly the way Razorpay does (HMAC SHA-256 over the raw
 * body, `x-razorpay-signature` header) and checks the route's answers.
 *
 * SAFE BY DEFAULT. With no --quote argument it uses a deliberately non-existent
 * quote id, so a correctly-signed event gets as far as the database lookup, fails
 * to find the quote, and returns 404 — proving the signature was accepted without
 * recording any payment. Nothing is written.
 *
 * Passing --quote=<real id> makes the last case record a REAL payment against a
 * REAL quote. That is a live mutation. It is opt-in for that reason.
 *
 * PREFER --from-db OVER --secret. Typing a secret into a shell command failed
 * three times in a row in practice — the placeholder went through verbatim twice,
 * and the third attempt sent the "first three characters" example including its
 * ellipsis. None of those were user error so much as a bad interface: a secret
 * that has to be re-typed to be tested will be mistyped. With --from-db the
 * script reads the tenant's stored secret exactly as the route does, so the
 * comparison is between the route and its own source of truth, and the value
 * never appears in a command line, a shell history, or a screenshot.
 *
 * Usage:
 *   node scripts/webhook-selftest.mjs --url=https://… --tenant=<uuid> --from-db
 *   node scripts/webhook-selftest.mjs --url=http://localhost:3200 --secret=whsec_xxx
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { loadEnvLocal } from "./lib/env-local.mjs";

const arg = (k, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

const BASE   = arg("url", "http://localhost:3000").replace(/\/$/, "");
const TENANT = arg("tenant");
const QUOTE  = arg("quote");
const FROM_DB = process.argv.includes("--from-db");

/**
 * Read the tenant's stored webhook secret the same way the route does, using the
 * service-role key from .env.local. The value is used to sign and then dropped —
 * it is never printed, not even masked.
 */
async function secretFromDb(tenantId) {
  /* Shared parser — this copy also kept a trailing comment inside a quoted
     value, and the value here is a webhook SECRET used to sign a request. */
  const env = loadEnvLocal();
  const url = env.NEXT_PUBLIC_SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env.local");

  const res = await fetch(
    `${url}/rest/v1/tenant_secrets?tenant_id=eq.${encodeURIComponent(tenantId)}&select=razorpay_webhook_secret`,
    { headers: { apikey: key, authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Supabase read failed: HTTP ${res.status}`);
  const rows = await res.json();
  const v = rows?.[0]?.razorpay_webhook_secret;
  if (typeof v !== "string" || !v.trim()) {
    throw new Error("No razorpay_webhook_secret stored for that tenant — save it in Settings first.");
  }
  return v;
}

let SECRET = arg("secret");
if (FROM_DB) {
  if (!TENANT) { console.error("--from-db needs --tenant=<uuid>"); process.exit(2); }
  try {
    SECRET = await secretFromDb(TENANT);
    console.log(`secret: read from the database for tenant ${TENANT.slice(0, 8)} (${SECRET.length} chars, not shown)`);
  } catch (err) {
    console.error(`Could not read the stored secret — ${err.message}`);
    process.exit(2);
  }
} else if (!SECRET) {
  console.error("Missing --secret=<signing secret>, or pass --from-db --tenant=<uuid> to read the stored one");
  process.exit(2);
} else if (/^(ASLI_SECRET|TUMHARA_SECRET_YAHAN|YOUR_SECRET|.*\.\.\.)$/.test(SECRET)) {
  // A placeholder was pasted verbatim. Say so, instead of reporting a 401 that
  // looks like the webhook is broken when nothing is wrong with it.
  console.error(`--secret looks like a placeholder ("${SECRET}"), not a real secret.`);
  console.error("Use --from-db --tenant=<uuid> instead and nothing needs typing.");
  process.exit(2);
}

const endpoint = `${BASE}/api/webhooks/razorpay${TENANT ? `?tenant=${encodeURIComponent(TENANT)}` : ""}`;
const quoteId  = QUOTE ?? "Q-WEBHOOK-SELFTEST-DOES-NOT-EXIST";
const isLive   = Boolean(QUOTE);

/** A payment.captured event shaped like Razorpay's. Amount is in PAISE. */
function event(amountPaise) {
  return JSON.stringify({
    event: "payment.captured",
    created_at: 1755000000,
    payload: {
      payment: {
        entity: {
          id: "pay_SELFTEST0000001",
          order_id: "order_SELFTEST00001",
          amount: amountPaise,
          currency: "INR",
          status: "captured",
          method: "upi",
          email: "selftest@example.com",
          notes: { quoteId },
        },
      },
      order: { entity: { id: "order_SELFTEST00001", receipt: quoteId, amount: amountPaise } },
    },
  });
}

const sign = (body, secret) => crypto.createHmac("sha256", secret).update(body).digest("hex");

async function post(label, body, signature, expected) {
  const headers = { "content-type": "application/json" };
  if (signature !== null) headers["x-razorpay-signature"] = signature;
  let res, text;
  try {
    res  = await fetch(endpoint, { method: "POST", headers, body });
    text = await res.text();
  } catch (err) {
    console.log(`✗ ${label}\n    could not reach ${endpoint} — ${err.message}`);
    return false;
  }
  const ok = expected.includes(res.status);
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  console.log(`    HTTP ${res.status} (expected ${expected.join(" or ")})  ${text.slice(0, 120)}`);
  return ok;
}

console.log(`\nRazorpay webhook self-test → ${endpoint}`);
console.log(`quote: ${quoteId}${isLive ? "  ⚠ LIVE — this will record a real payment" : "  (non-existent, nothing will be written)"}\n`);

const body = event(1180000);   // ₹11,800.00
const results = [];

// 1. No signature at all. Must be refused — this is the whole security model.
results.push(await post("unsigned event is rejected", body, null, [401]));

// 2. Signed with the wrong secret. Must be refused.
results.push(await post("wrongly-signed event is rejected", body, sign(body, `${SECRET}-wrong`), [401]));

// 3. Tampered body, valid-for-the-original signature. Must be refused — proves
//    the HMAC covers the payload and not just the header.
const tampered = event(100);   // ₹1.00 — an attacker lowering the amount
results.push(await post("tampered amount is rejected", tampered, sign(body, SECRET), [401]));

// 4. Correctly signed. 404 means the signature was ACCEPTED and the route got as
//    far as looking the quote up — which is exactly what we are proving.
results.push(
  await post(
    isLive ? "correctly-signed event is processed" : "correctly-signed event passes verification",
    body,
    sign(body, SECRET),
    isLive ? [200] : [404],
  ),
);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) {
  console.log("\nA failing 401 on the last check means the secret you passed does not match");
  console.log("the one the route resolved — check the tenant's stored secret, or drop --tenant");
  console.log("to test against RAZORPAY_WEBHOOK_SECRET from the environment instead.");
}
process.exit(passed === results.length ? 0 : 1);
