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
const LOCAL = process.argv.includes("--local");
const REF = LOCAL ? null : process.argv[2];
const NO_WIPE = process.argv.includes("--no-wipe");

/** The live business database. Nothing here may ever point at it. */
const PRODUCTION_REF = "ontpnqjoysjgrlsukecm";

if (!LOCAL && !REF) {
  console.error("usage: node scripts/rebuild-db.mjs <project-ref> [--no-wipe]");
  console.error("       node scripts/rebuild-db.mjs --local");
  process.exit(2);
}
if (REF === PRODUCTION_REF) {
  console.error("REFUSING: that is the PRODUCTION project — this script DROPS the public schema.");
  process.exit(2);
}

/** Where the SQL goes. --local targets the developer's own Docker Postgres. */
const TARGET = LOCAL ? ["--local"] : ["--linked", "--project-ref", REF];

/* Container name is `supabase_db_<project_id>` where project_id comes from
   supabase/config.toml. Read it rather than hardcoded, so renaming the project does not
   silently break local setup. */
const LOCAL_DB_CONTAINER = (() => {
  if (!LOCAL) return null;
  const toml = readFileSync("supabase/config.toml", "utf8");
  const id = /^project_id\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  if (!id) { console.error("Could not read project_id from supabase/config.toml"); process.exit(1); }
  return `supabase_db_${id}`;
})();

/**
 * Run SQL against the target.
 *
 * Two different mechanisms, because they have different limits:
 *  • remote → `supabase db query --linked`, which posts the whole script to the
 *    Management API and is happy with many statements.
 *  • local  → psql inside the Postgres container. `supabase db query --local` sends the
 *    script as a PREPARED STATEMENT, which Postgres rejects the moment there is more
 *    than one command in it: "cannot insert multiple commands into a prepared
 *    statement". baseline.sql has thousands.
 */
function run(sqlOrFile, { isFile = false } = {}) {
  let tmp = null;
  let file = sqlOrFile;
  if (!isFile) {
    tmp = `${process.env.TEMP || "/tmp"}/rebuild-${Date.now()}.sql`;
    writeFileSync(tmp, sqlOrFile);
    file = tmp;
  }
  try {
    if (LOCAL) {
      /* -v ON_ERROR_STOP=1 so a failure half-way is an error, not a half-built database
         reported as success. --single-transaction so a failure leaves nothing behind. */
      return execFileSync(
        "docker",
        ["exec", "-i", LOCAL_DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres",
         "-v", "ON_ERROR_STOP=1", "--single-transaction", "-q"],
        { encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024,
          input: readFileSync(file, "utf8") },
      );
    }
    return execFileSync(
      NPX,
      ["supabase", "db", "query", ...TARGET, "-f", file],
      { encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, SUPABASE_ACCESS_TOKEN: "" } },
    );
  } finally { if (tmp) { try { unlinkSync(tmp); } catch { /* best effort */ } } }
}

const STEPS = [
  { file: "supabase/baseline.sql",         label: "schema (tables, functions, policies, triggers, indexes)" },
  { file: "supabase/baseline-storage.sql", label: "storage buckets + policies" },
  /* Seed runs LAST and only locally. `supabase start` would otherwise run it straight
     after the (empty) migrations folder and fail with
     `relation "public.tenants" does not exist` — which is why [db.seed] is disabled in
     config.toml. A remote project gets schema only; nobody wants demo rows in staging. */
  ...(LOCAL ? [{ file: "supabase/seed.sql", label: "seed data (local only)", optional: true }] : []),
];

for (const s of STEPS) {
  if (!existsSync(s.file) && !s.optional) {
    console.error(`Missing ${s.file} — cannot rebuild.`);
    process.exit(1);
  }
}

console.log(`Rebuilding ${LOCAL ? "the LOCAL database" : REF}\n`);

if (!NO_WIPE) {
  process.stdout.write("  wiping public schema… ");
  /* client_min_messages: without it the DROP CASCADE prints 250 NOTICE lines naming
     every object it removes, which reads like a catastrophe to anyone running setup for
     the first time. */
  run(`set client_min_messages = warning;
drop schema if exists public cascade;
create schema public;
grant usage on schema public to anon, authenticated, service_role;
grant all on schema public to postgres;`);
  console.log("done");
}

for (const s of STEPS) {
  if (!existsSync(s.file)) { console.log(`  skipping ${s.file} (not present)`); continue; }
  const bytes = readFileSync(s.file).length;
  process.stdout.write(`  applying ${s.file} (${Math.round(bytes / 1024)} KB) — ${s.label}… `);
  run(s.file, { isFile: true });
  console.log("done");
}

if (LOCAL) {
  console.log(`\nRebuilt. Your local database now carries production's schema — and none of its data.`);
} else {
  console.log(`\nRebuilt. Now verify it against production:\n  node scripts/db-compare.mjs ${PRODUCTION_REF} ${REF}`);
  console.log("Anything other than a clean match means the baseline is stale — regenerate it.");
}
