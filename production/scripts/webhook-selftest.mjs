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
 * Usage:
 *   node scripts/webhook-selftest.mjs --url=http://localhost:3200 --secret=whsec_xxx
 *   node scripts/webhook-selftest.mjs --url=... --secret=... --tenant=<uuid>
 */
import crypto from "node:crypto";

const arg = (k, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

const BASE   = arg("url", "http://localhost:3000").replace(/\/$/, "");
const SECRET = arg("secret");
const TENANT = arg("tenant");
const QUOTE  = arg("quote");

if (!SECRET) {
  console.error("Missing --secret=<razorpay webhook signing secret>");
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
