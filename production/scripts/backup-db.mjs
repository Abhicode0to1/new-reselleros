/**
 * Off-database data backup via the READ-ONLY Supabase MCP server.
 *
 * Why this exists: the project is on the Supabase free plan, which has no
 * automatic backups and no PITR (the dashboard shows "No backups"). The in-app
 * snapshots (backup.snapshots) live INSIDE the same database, so they are an
 * undo button, not a backup. This writes the data OUT, to a folder outside the
 * git repo (the dump contains customer PII and must never be committed).
 *
 * Covers DATA only. Schema lives in production/supabase/migrations/ (git).
 *
 * Usage: node dump.mjs <output-dir>
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = process.argv[2];
if (!OUT_DIR) { console.error("usage: node dump.mjs <output-dir>"); process.exit(1); }

const child = spawn("npx",
  ["-y", "@supabase/mcp-server-supabase@latest", "--read-only",
   "--project-ref=ontpnqjoysjgrlsukecm", "--features=database,docs"],
  { stdio: ["pipe", "pipe", "pipe"], shell: true });

let nextId = 10;
const pending = new Map();
let buf = "";

child.stdout.on("data", (c) => {
  buf += c.toString();
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const r = pending.get(j.id);
    if (!r) continue;
    pending.delete(j.id);
    if (j.error) return r.reject(new Error(JSON.stringify(j.error)));
    // Don't filter on c2.type — this server doesn't always tag it "text", and
    // filtering silently produced an empty string (→ a 0-table "backup").
    const text = (j.result?.content ?? []).map(c2 => c2?.text ?? "").join("");
    r.resolve(text);
  }
});
child.stderr.on("data", () => {});

const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");

function sql(query) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method: "tools/call",
           params: { name: "execute_sql", arguments: { query } } });
  });
}

/** The server wraps rows in an <untrusted-data-…> fence — pull the JSON out. */
function rows(text) {
  // The tool result is a JSON STRING that itself contains the fenced payload,
  // so unwrap it first — otherwise the fence content is still backslash-escaped
  // and JSON.parse silently yields nothing (which is how the first run wrote a
  // 0-table "backup").
  let s = text;
  try { const o = JSON.parse(text); if (typeof o?.result === "string") s = o.result; } catch { /* already raw */ }

  // The server's preamble NAMES the fence id inline ("…within the below
  // <untrusted-data-UUID> boundaries") as a prompt-injection defence, so a naive
  // /<untrusted-data-[^>]*>([\s\S]*?)<\/untrusted-data-/ matches that MENTION and
  // captures the preamble instead of the rows. Anchor off the CLOSING tag and
  // walk back to the last opening tag before it.
  const close = s.lastIndexOf("</untrusted-data-");
  if (close === -1) { try { return JSON.parse(s); } catch { return []; } }
  const openStart = s.lastIndexOf("<untrusted-data-", close - 1);
  if (openStart === -1) return [];
  const openEnd = s.indexOf(">", openStart);
  if (openEnd === -1) return [];
  const inner = s.slice(openEnd + 1, close).trim();
  try { return JSON.parse(inner); } catch { return []; }
}

send({ jsonrpc: "2.0", id: 1, method: "initialize",
       params: { protocolVersion: "2024-11-05", capabilities: {},
                 clientInfo: { name: "dump", version: "1" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });

const CAP = 5000; // rows per table; the whole DB is ~1.2k rows today

try {
  await new Promise(r => setTimeout(r, 3000)); // let the server come up

  const tables = rows(await sql(
    "select tablename from pg_tables where schemaname='public' order by tablename"
  )).map(t => t.tablename);

  mkdirSync(OUT_DIR, { recursive: true });

  const data = {};
  const manifest = [];
  let total = 0, truncated = [];

  for (const t of tables) {
    const text = await sql(`select * from public."${t}" limit ${CAP}`);
    const r = rows(text);
    data[t] = r;
    total += r.length;
    manifest.push({ table: t, rows: r.length });
    if (r.length === CAP) truncated.push(t);
    process.stdout.write(`  ${String(r.length).padStart(5)}  ${t}\n`);
  }

  // Schema-side capture. The migrations in git are the intended schema, but this
  // repo has a documented history of objects existing in prod that were never
  // committed (0003_freeze_baseline consolidated 19 of them; 0146 captured more).
  // Dumping the live definitions makes the backup restorable on its own AND
  // doubles as a drift detector against production/supabase/migrations/.
  process.stdout.write("\n  -- schema --\n");
  const schema = {};
  schema.columns = rows(await sql(
    `select table_name, column_name, data_type, is_nullable, column_default
       from information_schema.columns where table_schema='public'
      order by table_name, ordinal_position`));
  schema.policies = rows(await sql(
    `select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
       from pg_policies where schemaname='public' order by tablename, policyname`));
  schema.functions = rows(await sql(
    `select p.proname, pg_get_functiondef(p.oid) as definition
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' order by p.proname`));
  // pg_trigger, NOT information_schema.triggers — the latter only shows triggers
  // on tables the caller owns, so it silently returned 0 while 46 actually exist
  // (handle_updated_at, the cross-tenant invoice mirror, task completion, …).
  schema.triggers = rows(await sql(
    `select c.relname as table_name, t.tgname as trigger_name, pg_get_triggerdef(t.oid) as definition
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname='public' and not t.tgisinternal
      order by c.relname, t.tgname`));
  schema.indexes = rows(await sql(
    `select tablename, indexname, indexdef from pg_indexes where schemaname='public'
      order by tablename, indexname`));
  // Constraints (PK / FK / UNIQUE / CHECK) with their full DDL. Without these the
  // backup records a table's columns but not its RULES — and 11 tables exist in
  // prod that git cannot recreate, so this is the only place their definition
  // survives. `conrelid::regclass` gives the table name.
  schema.constraints = rows(await sql(
    `select c.conrelid::regclass::text as table_name, c.conname as name,
            c.contype as type, pg_get_constraintdef(c.oid) as definition
       from pg_constraint c
       join pg_namespace n on n.oid = c.connamespace
      where n.nspname='public'
      order by 1, 2`));
  schema.migrations_applied = rows(await sql(
    `select version, name from supabase_migrations.schema_migrations order by version`));
  for (const [k, v] of Object.entries(schema)) {
    process.stdout.write(`  ${String(v.length).padStart(5)}  ${k}\n`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(OUT_DIR, `resellersos-data-${stamp}.json`);
  writeFileSync(file, JSON.stringify({
    project_ref: "ontpnqjoysjgrlsukecm",
    taken_at_utc: new Date().toISOString(),
    kind: "data + live schema definitions (RLS policies, functions, triggers, indexes)",
    table_count: tables.length,
    row_count: total,
    tables: manifest,
    schema,
    data,
  }, null, 1));

  console.log(`\nTABLES: ${tables.length}   ROWS: ${total}`);
  if (truncated.length) console.log(`!! TRUNCATED at ${CAP}: ${truncated.join(", ")}`);
  console.log(`WROTE: ${file}`);
  process.exit(0);
} catch (e) {
  console.error("DUMP FAILED:", e.message);
  process.exit(1);
}
