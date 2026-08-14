/**
 * Proves the users→tenants embed is unambiguous.
 *
 * PostgREST answers HTTP 300 / PGRST201 when two foreign keys connect the tables
 * being embedded and the query does not say which one it means. That check runs
 * BEFORE row-level security, so the anon key is enough to test it — no session,
 * no data read, nothing written.
 *
 * Why this exists: `users` and `tenants` gained a SECOND foreign key in 0235
 * (tenants.gmail_sender_user_id -> users.id). From that moment the bare
 * `tenants(…)` embed in useCurrentUser failed for everyone, the hook returned
 * null, and the sidebar rendered "Loading… / Workspace" forever. Nothing about
 * that symptom points at a foreign key.
 *
 *   node scripts/check-embed-ambiguity.mjs
 *
 * Exits non-zero if the ambiguous form has stopped failing (meaning this guard no
 * longer proves anything) or if the pinned form has started failing.
 */
import { readFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!URL_ || !ANON) { console.error("Missing NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY"); process.exit(2); }

const COLS = "name,logo_url,gstin,email,phone,address,pin_code,contact_name,state,state_code," +
             "lut_number,lut_valid_upto,upi_vpa,upi_payee_name,grace_period_days," +
             "setup_completed_at,gstin_verified_at,gstin_verification";

async function probe(embed) {
  const select = `id,tenant_id,full_name,initials,color,role,can_view_deals,${embed}(${COLS})`;
  const res = await fetch(`${URL_}/rest/v1/users?select=${encodeURIComponent(select)}&limit=1`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
    cache: "no-store",
  });
  const body = await res.text();
  return { status: res.status, code: (body.match(/"code":"([^"]+)"/) ?? [])[1] ?? null };
}

const ambiguous = await probe("tenants");
const pinned    = await probe("tenants!users_tenant_id_fkey");

console.log(`bare   tenants(…)                    -> HTTP ${ambiguous.status} ${ambiguous.code ?? ""}`);
console.log(`pinned tenants!users_tenant_id_fkey  -> HTTP ${pinned.status} ${pinned.code ?? ""}`);

/* The pass condition is "the embed RESOLVED", not "the query returned rows".
 *
 * A first version of this script asserted `pinned.status === 200` and reported a
 * failure — wrongly. With the anon key, `users` is correctly blocked by RLS, so
 * the honest answer is 401/42501. That is a PASS here: reaching row-level
 * security means PostgREST already decided which foreign key to follow.
 * Ambiguity fails earlier, at 300, and never gets that far. Checking for 200
 * would have made this guard demand a security hole. */
let bad = false;
if (ambiguous.code !== "PGRST201") {
  console.error("\n! The ambiguous form no longer returns PGRST201. Either a foreign key was\n" +
                "  removed, or this guard is testing nothing. Re-check before trusting it.");
  bad = true;
}
if (pinned.code === "PGRST201" || pinned.status === 300) {
  console.error("\n! The pinned form is STILL ambiguous. useCurrentUser is broken for every\n" +
                "  user — identity silently falls back to 'no workspace'.");
  bad = true;
}
if (!bad) {
  console.log("\nOK — bare embed is ambiguous (300), pinned embed resolves and reaches RLS.");
  console.log("   401/42501 on the pinned probe is expected: anon may not read users.");
}
process.exit(bad ? 1 : 0);
