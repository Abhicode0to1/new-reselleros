/**
 * Rebuild a Supabase project's schema from the committed baseline.
 *
 *   node scripts/rebuild-db.mjs <project-ref> [--no-wipe]
 *
 * ─── WHY A BASELINE AND NOT THE MIGRATIONS ──────────────────────────────────
 * On 15 Aug 2026 the 218 files in supabase/migrations/ were run, in order, against an
 * empty database for the first time. They do not work. They produced 73 of production's
 * 87 tables and then stopped, because several tables were created directly in prod and
 * only captured in git LATER, under a higher number than the migration that uses them:
 *
 *     tenant_secrets   created in 0171   used in 0070   (101 files too late)
 *     reimbursements   created in 0224   used in 0133   ( 91 files too late)
 *     contacts, campaigns + 9 more — same story, all in 0224
 *
 * And 0224 cannot simply be moved earlier: it needs a unique constraint that a
 * mid-sequence migration adds. The dependency runs both ways, so no reordering fixes it.
 *
 * Nobody noticed for months because production already had those tables — the migrations
 * only ever ran against a database that was already correct. The consequences were real:
 * a new developer could not build a working database, and disaster recovery from
 * migrations alone would have produced a silently incomplete schema.
 *
 * So a fresh database is built from a SNAPSHOT of production instead:
 *
 *     supabase/baseline.sql           87 tables, 133 functions, 269 public policies,
 *                                     305 indexes, 11 enums, 1335 columns, 234 FKs
 *     supabase/baseline-storage.sql   6 storage buckets + their 17 policies
 *
 * ─── WHY THERE IS A SEPARATE STORAGE FILE ───────────────────────────────────
 * `supabase db dump --schema public` does not include the storage schema. Without that
 * second file a rebuilt database passes every public-schema check while file upload and
 * download quietly fail — the app uses storage for bill attachments and visiting-card
 * OCR. That is the failure mode this repo keeps hitting: not an error, a plausible
 * looking success.
 *
 * ─── REFRESHING THE BASELINE ────────────────────────────────────────────────
 * After a batch of migrations reaches production, regenerate it:
 *     npx supabase db dump --project-ref <prod-ref> --schema public -f supabase/baseline.sql
 * then re-run this script against a scratch project and confirm db-compare.mjs is clean.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";

const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const REF = process.argv[2];
const NO_WIPE = process.argv.includes("--no-wipe");

/** The live business database. Nothing here may ever point at it. */
const PRODUCTION_REF = "ontpnqjoysjgrlsukecm";

if (!REF) {
  console.error("usage: node scripts/rebuild-db.mjs <project-ref> [--no-wipe]");
  process.exit(2);
}
if (REF === PRODUCTION_REF) {
  console.error("REFUSING: that is the PRODUCTION project — this script DROPS the public schema.");
  process.exit(2);
}

function run(sqlOrFile, { isFile = false } = {}) {
  let tmp = null;
  let file = sqlOrFile;
  if (!isFile) {
    tmp = `${process.env.TEMP || "/tmp"}/rebuild-${Date.now()}.sql`;
    writeFileSync(tmp, sqlOrFile);
    file = tmp;
  }
  try {
    return execFileSync(
      NPX,
      ["supabase", "db", "query", "--linked", "--project-ref", REF, "-f", file],
      { encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, SUPABASE_ACCESS_TOKEN: "" } },
    );
  } finally { if (tmp) { try { unlinkSync(tmp); } catch { /* best effort */ } } }
}

const STEPS = [
  { file: "supabase/baseline.sql",         label: "schema (tables, functions, policies, triggers, indexes)" },
  { file: "supabase/baseline-storage.sql", label: "storage buckets + policies" },
];

for (const s of STEPS) {
  if (!existsSync(s.file)) { console.error(`Missing ${s.file} — cannot rebuild.`); process.exit(1); }
}

console.log(`Rebuilding ${REF}\n`);

if (!NO_WIPE) {
  process.stdout.write("  wiping public schema… ");
  run(`drop schema if exists public cascade;
create schema public;
grant usage on schema public to anon, authenticated, service_role;
grant all on schema public to postgres;`);
  console.log("done");
}

for (const s of STEPS) {
  const bytes = readFileSync(s.file).length;
  process.stdout.write(`  applying ${s.file} (${Math.round(bytes / 1024)} KB) — ${s.label}… `);
  run(s.file, { isFile: true });
  console.log("done");
}

console.log(`\nRebuilt. Now verify it against production:\n  node scripts/db-compare.mjs ${PRODUCTION_REF} ${REF}`);
console.log("Anything other than a clean match means the baseline is stale — regenerate it.");
