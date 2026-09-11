/**
 * One-command setup for a new developer.
 *
 *   npm run setup
 *
 * Checks the prerequisites, starts a local database, loads the schema, and tells you
 * exactly what is missing rather than failing halfway with a Postgres error.
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * Before this, a new developer's first day looked like: clone, `npm install`, `npm run
 * dev`, and a wall of errors — because `.env.local` is gitignored (50 keys, no note
 * saying which 8 actually matter), and because there was no way to get a database at
 * all. The 218 files in supabase/migrations-archive/ cannot build one; that took a day
 * to establish and is not something the next person should have to rediscover.
 *
 * Everything this script does, it explains. If it stops, it stops with a sentence you
 * can act on.
 */
import { execSync, execFileSync } from "node:child_process";
import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";

const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const env = { ...process.env, SUPABASE_ACCESS_TOKEN: "" };

let failed = false;
const ok   = (m) => console.log(`  ✅ ${m}`);
const warn = (m) => console.log(`  ⚠️  ${m}`);
const bad  = (m) => { console.log(`  ❌ ${m}`); failed = true; };

function has(cmd) {
  try { execSync(cmd, { stdio: "pipe" }); return true; } catch { return false; }
}

console.log("\nResellerOS — developer setup\n");

// ── 1. Prerequisites ───────────────────────────────────────────────────────
console.log("Checking what you have:");

if (has("node --version")) {
  const v = execSync("node --version", { encoding: "utf8" }).trim();
  const major = Number(v.replace(/^v/, "").split(".")[0]);
  major >= 20 ? ok(`Node ${v}`) : bad(`Node ${v} — this project needs 20 or newer`);
}

if (has("docker --version")) ok("Docker is installed");
else bad("Docker is not installed. Get Docker Desktop from docker.com/products/docker-desktop — the local database runs inside it.");

if (!failed && !has("docker info")) {
  bad("Docker is installed but not RUNNING. Open Docker Desktop and wait for it to say 'Engine running', then run this again.");
}

// ── 2. Environment file ────────────────────────────────────────────────────
console.log("\nEnvironment:");
if (existsSync(".env.local")) {
  ok(".env.local exists");
  const body = readFileSync(".env.local", "utf8");
  /* Only these actually stop the app from starting. The other ~40 keys in .env.example
     are for features that degrade gracefully (WhatsApp, Razorpay, Gemini, Sentry) — a
     new developer should not be blocked hunting for them. */
  const REQUIRED = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const missing = REQUIRED.filter((k) => !new RegExp(`^${k}=.+`, "m").test(body));
  if (missing.length) bad(`.env.local is missing: ${missing.join(", ")}`);
  else ok("the keys the app cannot start without are all set");
} else if (existsSync(".env.example")) {
  copyFileSync(".env.example", ".env.local");
  warn(".env.local created from .env.example — you must fill in the Supabase keys.");
  warn("Only 3 are needed to start: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY");
  warn("`npm run db:start` prints all three for your LOCAL database.");
} else {
  bad("No .env.local and no .env.example — something is wrong with this checkout.");
}

if (failed) {
  console.log("\nFix the ❌ items above, then run `npm run setup` again.\n");
  process.exit(1);
}

// ── 3. Local database ──────────────────────────────────────────────────────
console.log("\nLocal database:");
/**
 * `supabase start` must NOT apply the migrations, and this is the reason.
 *
 * Measured 8 Sep 2026: with [db.migrations] enabled, `supabase start` runs
 * supabase/migrations/ against an EMPTY database. The oldest file there
 * (20260816094848_add_lead_expected_close_date.sql) pre-dates the baseline snapshot, so it
 * dies on `relation "public.leads" does not exist`, the CLI stops the containers, and
 * `npm run setup` exits non-zero. On a fresh machine this step could never have worked.
 *
 * The schema arrives from the baseline in the NEXT step, and rebuild-db.mjs puts every
 * migration on top of it there, in order. So the migrations are not being skipped -- they
 * run at the only point in the sequence where they can succeed.
 *
 * The flag is restored in `finally`, so a crash or a Ctrl-C still leaves config.toml as it
 * was found. It is deliberately not left off: `supabase db push` reads the same flag.
 */
const CONFIG = "supabase/config.toml";
function startDatabaseWithoutMigrations() {
  const original = readFileSync(CONFIG, "utf8");
  const patched = original.replace(
    /(\[db\.migrations\][\s\S]*?^)enabled = true(\r?)$/m,
    "$1enabled = false$2",
  );
  if (patched === original) {
    warn(`could not switch migrations off in ${CONFIG} - if start fails on a missing table, this is why`);
  }
  writeFileSync(CONFIG, patched);
  try {
    execFileSync(NPX, ["supabase", "start"], { stdio: "inherit", shell: true, env });
  } finally {
    writeFileSync(CONFIG, original);
  }
}

let running = false;
try {
  const status = execFileSync(NPX, ["supabase", "status"], { encoding: "utf8", shell: true, env, stdio: "pipe" });
  running = /API URL/.test(status);
} catch { running = false; }

if (running) ok("already running");
else {
  console.log("  starting it (first run downloads a few images — this takes a while)…");
  startDatabaseWithoutMigrations();
  ok("started");
}

/* The schema does NOT come from supabase/migrations/ ALONE. It starts from the baseline —
   a snapshot of production — and rebuild-db.mjs then applies every migration on top, in
   order. Neither half is optional: the migrations cannot build a database from empty (see
   supabase/migrations-archive/README.md), and the baseline is a 2 Sep snapshot that is
   roughly 38 tables behind HEAD because those migrations never reached production. */
console.log("\nLoading the schema from the production baseline:");
execFileSync("node", ["scripts/rebuild-db.mjs", "--local"], { stdio: "inherit", shell: true, env });

console.log(`
Done.

  npm run dev          start the app        → http://localhost:3000
  npm run db:studio    browse the database  → http://localhost:14323
  npm run db:stop      stop the database    (it keeps running otherwise)

Your database is LOCAL and yours alone — nothing you do here touches production or
anyone else's work. Read AGENTS.md before your first change; it is short and every rule
in it is there because it cost somebody something.
`);
