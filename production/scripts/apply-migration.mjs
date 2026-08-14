/**
 * Apply a migration file through the Supabase Management API, ONE `begin; … commit;`
 * batch at a time (CLAUDE.md §25.6 — a whole file runs as one transaction in the
 * SQL editor, so one late failure silently rolls back the parts that worked).
 *
 * The token is the same personal access token the read-only MCP server uses; it
 * is read from ~/.claude.json and never printed.
 *
 *   node apply-migration.mjs <path-to.sql> [--dry]
 */
import { readFileSync } from "node:fs";

const FILE = process.argv[2];
const DRY  = process.argv.includes("--dry");
if (!FILE) { console.error("usage: node apply-migration.mjs <file.sql> [--dry]"); process.exit(2); }

const cfg = JSON.parse(readFileSync(process.env.USERPROFILE + "/.claude.json", "utf8"));
const srv = Object.entries(cfg.mcpServers || {}).find(([k]) => /supabase/i.test(k))?.[1];
const TOKEN = srv?.env?.SUPABASE_ACCESS_TOKEN;
const REF = (srv?.args || []).find((a) => a.startsWith("--project-ref="))?.split("=")[1];
if (!TOKEN || !REF) { console.error("Could not find token / project-ref in ~/.claude.json"); process.exit(2); }

const sql = readFileSync(FILE, "utf8");
// `rollback;` closes a block too — that is how supabase/tests/*.test.sql are
// written, so the same runner executes a migration and a regression test.
const batches = [...sql.matchAll(/^begin;([\s\S]*?)^(?:commit|rollback);/gm)].map((m) => m[0]);

if (batches.length === 0) { console.error("No `begin; … commit|rollback;` batches found."); process.exit(2); }
console.log(`project ${REF} · ${FILE}`);
console.log(`${batches.length} batch(es)\n`);

async function run(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

for (let i = 0; i < batches.length; i++) {
  const head = batches[i].split("\n").find((l) => l.trim() && !l.startsWith("begin")) ?? "";
  console.log(`── batch ${i + 1}/${batches.length}  ${head.trim().slice(0, 70)}`);
  if (DRY) { console.log("   (dry run — not sent)\n"); continue; }
  const r = await run(batches[i]);
  if (!r.ok) {
    console.error(`   FAILED HTTP ${r.status}\n   ${r.body.slice(0, 900)}`);
    console.error("\nStopping. Nothing after this batch was sent.");
    process.exit(1);
  }
  console.log(`   ok  ${r.body.slice(0, 160)}\n`);
}
console.log("All batches applied. Run the file's VERIFY block separately.");
