/**
 * Idempotent setup for cross-tenant E2E test fixtures.
 *
 * Creates two dedicated test tenants + owner users isolated from
 * production data. Re-runnable any time — finds existing rows by
 * email instead of duplicating.
 *
 *   node scripts/setup-e2e-tenants.mjs
 *
 * Outputs the tenant IDs + credentials that e2e/fixtures/tenants.ts
 * consumes. Credentials are intentionally hardcoded (these are test
 * accounts in test data, not production secrets).
 *
 * Why dedicated test users (not real ones):
 *   - Tests mutate data (create leads, record payments). Doing that
 *     on Pardeep's real tenant would pollute his dashboard.
 *   - Two tenants are needed to assert isolation.
 *   - Idempotent so CI can run it before every test suite.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf-8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const idx = l.indexOf("=");
      const key = l.slice(0, idx).trim();
      const raw = l.slice(idx + 1).trim();
      /* ─── A QUOTED VALUE ENDS AT ITS CLOSING QUOTE ──────────────────────────
         Everything after it is a comment. This used to be
         `.replace(/^"|"$/g, "")`, which strips a quote from each END of the
         line — so a trailing comment stayed INSIDE the value.

         Measured 11 Sep 2026. `.env.local` carries

           SUPABASE_SERVICE_ROLE_KEY="ey…"  # LOCAL demo key — same on every local supabase

         and the parsed "key" was 217 characters of JWT plus that sentence. It
         went into an HTTP header, and Node refused it:

           TypeError: Cannot convert argument to a ByteString because the
           character at index 191 has a value of 8212

         8212 is the em dash in the comment. The message names a character
         offset and no file, so it reads as a corrupt service-role key — which
         sends you rotating a key that was never wrong. `supabase.auth.admin`
         reported it as an `AuthRetryableFetchError` with `status: 0`, i.e. it
         looked like the local stack being unreachable too.

         Eleven other scripts in this directory carry the same block verbatim
         and are broken the same way; recorded in TASKS.md rather than fixed
         here, because this one is what the current task needed. */
      const quoted = raw.match(/^"([^"]*)"/) ?? raw.match(/^'([^']*)'/);
      /* Unquoted values get the same treatment dotenv gives them: a comment
         starts at whitespace followed by `#`. The space is required, so a `#`
         inside an unquoted value survives. */
      return [key, quoted ? quoted[1] : raw.replace(/\s+#.*$/, "")];
    })
);

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Test fixture definitions — kept in sync with e2e/fixtures/tenants.ts
const FIXTURES = [
  {
    email:    "e2e-tenant-a@resellersos.test",
    password: "e2e-test-password-A-9176",
    fullName: "E2E Tenant A Owner",
    company:  "E2E Test Tenant A",
    gstin:    "27AAAAA0000A1Z5",
    state:    "Maharashtra",
    stateCode:"27",
  },
  {
    email:    "e2e-tenant-b@resellersos.test",
    password: "e2e-test-password-B-3382",
    fullName: "E2E Tenant B Owner",
    company:  "E2E Test Tenant B",
    gstin:    "29BBBBB0000B1Z5",
    state:    "Karnataka",
    stateCode:"29",
  },
];

async function findAuthUserByEmail(email) {
  // Admin API: paginate users until we find one with the email.
  // For 2-3 test users this is fine. (Supabase has no admin-getByEmail yet.)
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const found = data.users.find((u) => u.email === email);
    if (found) return found;
    if (data.users.length < 200) return null;
    page += 1;
  }
}

async function ensureFixture(fx) {
  console.log(`\n── ${fx.email} ──`);

  // 1. Auth user — create if missing, otherwise rotate password to known value
  let authUser = await findAuthUserByEmail(fx.email);
  if (!authUser) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: fx.email,
      password: fx.password,
      email_confirm: true,
      user_metadata: { full_name: fx.fullName, e2e: true },
    });
    if (error) throw new Error(`auth.create failed: ${error.message}`);
    authUser = data.user;
    console.log(`  ✓ auth user created (${authUser.id})`);
  } else {
    // Reset to known password — keeps tests stable even if password was changed manually
    const { error } = await supabase.auth.admin.updateUserById(authUser.id, {
      password: fx.password,
      email_confirm: true,
    });
    if (error) throw new Error(`auth.update failed: ${error.message}`);
    console.log(`  ✓ auth user exists (${authUser.id}), password reset`);
  }

  // 2. Tenant — find by email (test convention), insert if absent
  const { data: existingTenant, error: tQueryErr } = await supabase
    .from("tenants").select("id, name").eq("email", fx.email).maybeSingle();
  if (tQueryErr) throw tQueryErr;

  let tenantId;
  if (existingTenant) {
    tenantId = existingTenant.id;
    console.log(`  ✓ tenant exists (${tenantId})`);
  } else {
    const { data: newTenant, error: tInsErr } = await supabase
      .from("tenants").insert({
        name:       fx.company,
        gstin:      fx.gstin,
        state:      fx.state,
        state_code: fx.stateCode,
        email:      fx.email,
      }).select("id").single();
    if (tInsErr) throw tInsErr;
    tenantId = newTenant.id;
    console.log(`  ✓ tenant created (${tenantId})`);
  }

  // 3. public.users row — links auth user to tenant
  const { data: existingPubUser, error: uQueryErr } = await supabase
    .from("users").select("id, tenant_id").eq("id", authUser.id).maybeSingle();
  if (uQueryErr) throw uQueryErr;

  if (existingPubUser) {
    if (existingPubUser.tenant_id !== tenantId) {
      // Re-link in case of stale state
      const { error: relinkErr } = await supabase
        .from("users").update({ tenant_id: tenantId }).eq("id", authUser.id);
      if (relinkErr) throw relinkErr;
      console.log(`  ✓ users row re-linked to tenant`);
    } else {
      console.log(`  ✓ users row already linked`);
    }
  } else {
    const initials = fx.fullName.split(/\s+/).map((s) => s[0].toUpperCase()).slice(0, 2).join("");
    const { error: uInsErr } = await supabase.from("users").insert({
      id:        authUser.id,
      tenant_id: tenantId,
      email:     fx.email,
      full_name: fx.fullName,
      initials,
      role:      "owner",
      color:     "amber",
    });
    if (uInsErr) throw uInsErr;
    console.log(`  ✓ users row created`);
  }

  return { ...fx, authUserId: authUser.id, tenantId };
}

async function main() {
  console.log("E2E fixture setup — idempotent");
  console.log("================================");

  const results = [];
  for (const fx of FIXTURES) {
    results.push(await ensureFixture(fx));
  }

  console.log("\n✅ DONE — fixtures ready");
  console.log("\nCopy these into e2e/fixtures/tenants.ts if the values drift:");
  for (const r of results) {
    console.log(`  ${r.email.padEnd(38)} tenant=${r.tenantId} user=${r.authUserId}`);
  }
}

main().catch((e) => {
  console.error("\n❌ Setup failed:", e.message);
  console.error(e);
  process.exit(1);
});
