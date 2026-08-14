/**
 * Delete Supabase Auth accounts that have NO public.users row (stranded).
 *
 * ─── WHY THIS NEEDS ITS OWN RECORD ──────────────────────────────────────────
 * scripts/backup-tenant-data.mjs dumps what PostgREST exposes, which does NOT
 * include `auth.users`. So the off-database backup that protects a tenant delete
 * does NOT cover this operation at all. This script therefore writes the full
 * list it is about to delete to a JSON file FIRST, and refuses to continue if it
 * cannot. That file is the only record afterwards.
 *
 * ─── THE SET IS COMPUTED, NOT TYPED ─────────────────────────────────────────
 * "Stranded" is derived live: an auth account with no matching public.users row.
 * Hardcoding emails would go stale the moment somebody is claimed or invited —
 * and the failure would be deleting a person who had just been given a workspace.
 * Anyone holding a users row is skipped, and the script asserts that afterwards.
 *
 *   node scripts/delete-stranded-auth-users.mjs --out "<file.json>"
 *   node scripts/delete-stranded-auth-users.mjs --out "<file.json>" --apply
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const APPLY = process.argv.includes("--apply");
const oIdx  = process.argv.indexOf("--out");
const OUT   = oIdx > -1 ? process.argv[oIdx + 1] : null;

if (!OUT) {
  console.error('Refusing: pass --out "<file.json>" — auth accounts are not in any other backup.');
  process.exit(2);
}
const repoRoot = resolve(process.cwd(), "..");
if (resolve(OUT).startsWith(repoRoot)) {
  console.error(`Refusing to write the record inside the repo (${repoRoot}) — it holds personal data.`);
  process.exit(2);
}

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/* listUsers() with {page, perPage} returned "Database error finding users" on this
 * project, so it is called plainly. That reintroduces the silent-truncation risk
 * the paging was there to avoid, so the result is checked against EXPECTED_TOTAL
 * below: if the API ever returns fewer than every account, the script stops
 * rather than deleting a partial set and reporting success. */
async function listAllAuthUsers() {
  const { data, error } = await sb.auth.admin.listUsers();
  if (error) { console.error("listUsers failed:", error.message); process.exit(1); }
  return data?.users ?? [];
}

const EXPECTED_TOTAL = Number(process.env.EXPECTED_AUTH_TOTAL ?? 0);
const authUsers = await listAllAuthUsers();
if (EXPECTED_TOTAL && authUsers.length !== EXPECTED_TOTAL) {
  console.error(`Refusing: listUsers returned ${authUsers.length}, expected ${EXPECTED_TOTAL}. ` +
                `The list is truncated or the count moved — re-check before deleting.`);
  process.exit(2);
}

const { data: profiles, error: pErr } = await sb.from("users").select("id, email, role");
if (pErr) { console.error("profile read failed:", pErr.message); process.exit(1); }
const hasProfile = new Set((profiles ?? []).map((p) => p.id));

const stranded = authUsers.filter((u) => !hasProfile.has(u.id));

console.log(`auth accounts : ${authUsers.length}`);
console.log(`with profile  : ${hasProfile.size}  (never touched)`);
console.log(`STRANDED      : ${stranded.length}\n`);
for (const u of stranded) {
  const last = u.last_sign_in_at ? u.last_sign_in_at.slice(0, 10) : "never";
  console.log(`  ${(u.email ?? "(no email)").padEnd(38)} last sign-in ${last}`);
}

if (stranded.length === 0) { console.log("\nNothing to do."); process.exit(0); }

// The record, written BEFORE anything is deleted.
mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  takenAt: new Date().toISOString(),
  note: "Stranded Supabase Auth accounts deleted by scripts/delete-stranded-auth-users.mjs. Not recoverable from the PostgREST table backup — auth.users is not exposed there.",
  accounts: stranded.map((u) => ({
    id: u.id, email: u.email, created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at, provider: u.app_metadata?.provider ?? null,
    user_metadata: u.user_metadata ?? null,
  })),
}, null, 2), "utf8");
console.log(`\nrecord written: ${OUT}`);

if (!APPLY) {
  console.log("Dry run. Nothing deleted. Re-run with --apply.");
  process.exit(0);
}

let ok = 0, failed = 0;
for (const u of stranded) {
  const { error } = await sb.auth.admin.deleteUser(u.id);
  if (error) { console.error(`  FAILED ${u.email}: ${error.message}`); failed++; }
  else ok++;
}

// Re-derive rather than trust the loop: the assertion that matters is that every
// remaining auth account still has a profile.
const after = await listAllAuthUsers();
const leftStranded = after.filter((u) => !hasProfile.has(u.id));

console.log(`\ndeleted ${ok}, failed ${failed}`);
console.log(`auth accounts now: ${after.length}   still stranded: ${leftStranded.length}`);
if (after.length !== hasProfile.size || leftStranded.length !== 0) {
  console.error("! Unexpected final state — check the record file before doing anything else.");
  process.exit(1);
}
console.log("Every remaining auth account has a workspace.");
