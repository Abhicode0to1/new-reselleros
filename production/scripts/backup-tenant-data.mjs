/**
 * Off-database data backup using the service-role key directly.
 *
 * ─── WHY THIS EXISTS ALONGSIDE backup-db.mjs ─────────────────────────────────
 * `backup-db.mjs` talks to the read-only Supabase MCP server. That path returned
 * `Unauthorized` on 13 Aug 2026 (expired access token), which means the ONE
 * script standing between a destructive operation and permanent data loss did
 * not run. A backup you cannot execute is not a backup.
 *
 * This one uses SUPABASE_SERVICE_ROLE_KEY from .env.local — the same credential
 * the app itself uses — so it works whenever the app works. Read-only: it issues
 * SELECTs and writes files. It never mutates the database.
 *
 * The project is on the Supabase free plan: no automatic backups, no PITR
 * (see docs/BACKUP.md). The in-app snapshots live INSIDE the same database, so
 * they are an undo button, not a backup. RUN THIS BEFORE ANY DELETE.
 *
 * Usage — output dir MUST be outside the git repo (the dump holds customer PII):
 *
 *   node scripts/backup-tenant-data.mjs "C:/Users/mso50/ResellerOS-backups/2026-08-13"
 *
 * Optional second arg limits the dump to one tenant:
 *
 *   node scripts/backup-tenant-data.mjs <out-dir> fbb976f1-9090-4f10-9726-0901bd144e42
 *
 * Verify afterwards by reading manifest.json — it records a row count per table.
 * A table that dumped 0 rows when you expected data is the signal to STOP.
 */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnvLocal } from "./lib/env-local.mjs";

const OUT_DIR = process.argv[2];
const ONLY_TENANT = process.argv[3] ?? null;

if (!OUT_DIR) {
  console.error('usage: node scripts/backup-tenant-data.mjs "<output-dir>" [tenant-id]');
  process.exit(2);
}

// Refuse to write inside the repo — a dump of customer PII must never be
// committable, and .gitignore is one careless `git add -f` away from failing.
const repoRoot = resolve(process.cwd(), "..");
if (resolve(OUT_DIR).startsWith(repoRoot)) {
  console.error(`Refusing to write inside the repo (${repoRoot}). Pick a folder outside it.`);
  process.exit(2);
}

/* Shared parser — this was six copies of a regex that stripped a quote off each
   END OF THE LINE, so a quoted value followed by a comment kept the comment.
   See scripts/lib/env-local.mjs for the error it produced. */
const env = loadEnvLocal();
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(2);
}
console.log("project ref :", URL.replace(/^https:\/\/([^.]+).*/, "$1"));
console.log("output dir  :", OUT_DIR);
console.log("tenant      :", ONLY_TENANT ?? "ALL");

const sb = createClient(URL, KEY, { auth: { persistSession: false } });

/** Every table PostgREST exposes, discovered rather than hardcoded — a
 *  hardcoded list silently misses tables added since it was written. */
async function discoverTables() {
  const res = await fetch(`${URL}/rest/v1/`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`schema discovery failed: HTTP ${res.status}`);
  const spec = await res.json();
  const defs = spec.definitions || spec.components?.schemas || {};
  return Object.entries(defs).map(([name, d]) => ({
    name,
    hasTenant: Object.keys(d.properties || {}).includes("tenant_id"),
  }));
}

/** Page through a table — a single select silently truncates at PostgREST's
 *  max-rows, which would produce a backup that looks complete and isn't. */
async function dumpTable(name, hasTenant) {
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(name).select("*").range(from, from + PAGE - 1);
    if (ONLY_TENANT && hasTenant) q = q.eq("tenant_id", ONLY_TENANT);
    const { data, error } = await q;
    if (error) return { error: error.message };
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return { rows };
}

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const tables = await discoverTables();
const manifest = { takenAt: new Date().toISOString(), projectRef: URL.replace(/^https:\/\/([^.]+).*/, "$1"), tenant: ONLY_TENANT, tables: {} };
let total = 0, failed = 0;

for (const { name, hasTenant } of tables.sort((a, b) => a.name.localeCompare(b.name))) {
  const { rows, error } = await dumpTable(name, hasTenant);
  if (error) {
    console.log(`  SKIP ${name.padEnd(30)} ${error.slice(0, 60)}`);
    manifest.tables[name] = { error };
    failed++;
    continue;
  }
  writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(rows, null, 1), "utf8");
  manifest.tables[name] = { rows: rows.length, tenantScoped: hasTenant };
  total += rows.length;
  if (rows.length > 0) console.log(`  ok   ${name.padEnd(30)} ${rows.length}`);
}

writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

console.log(`\nTABLES: ${tables.length}   ROWS: ${total}   FAILED: ${failed}`);
console.log(`manifest: ${join(OUT_DIR, "manifest.json")}`);
if (failed > 0) {
  console.log("\n‼ Some tables did not dump. DO NOT run any delete until you know why.");
  process.exit(1);
}
console.log("\nBackup complete. Open manifest.json and confirm the row counts match what you expect.");
