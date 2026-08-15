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
import { existsSync, copyFileSync, readFileSync } from "node:fs";

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
let running = false;
try {
  const status = execFileSync(NPX, ["supabase", "status"], { encoding: "utf8", shell: true, env, stdio: "pipe" });
  running = /API URL/.test(status);
} catch { running = false; }

if (running) ok("already running");
else {
  console.log("  starting it (first run downloads a few images — this takes a while)…");
  execFileSync(NPX, ["supabase", "start"], { stdio: "inherit", shell: true, env });
  ok("started");
}

/* The schema does NOT come from supabase/migrations/. It comes from the baseline —
   a snapshot of production. See supabase/migrations-archive/README.md for why. */
console.log("\nLoading the schema from the production baseline:");
execFileSync("node", ["scripts/rebuild-db.mjs", "--local"], { stdio: "inherit", shell: true, env });

console.log(`
Done.

  npm run dev          start the app        → http://localhost:3000
  npm run db:studio    browse the database  → http://localhost:54323
  npm run db:stop      stop the database    (it keeps running otherwise)

Your database is LOCAL and yours alone — nothing you do here touches production or
anyone else's work. Read AGENTS.md before your first change; it is short and every rule
in it is there because it cost somebody something.
`);
