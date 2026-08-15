/**
 * Count every kind of schema object in one or two Supabase projects, and diff them.
 *
 * Exists because "staging looks like production" is the kind of claim that is only
 * worth anything as a number. On 15 Aug a rebuild of staging from this repo's 218
 * migrations produced 73 tables against production's 87 — the repo could not rebuild
 * its own database, and nothing in the app would have told anyone.
 *
 *   node scripts/db-compare.mjs <ref-A> [ref-B]
 *
 * With one ref it just counts. With two it prints A, B and what B is missing.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";

/* On Windows npx is npx.cmd and execFileSync cannot launch it directly — the failure
   is a confusing ENOENT-shaped dump that names the whole argv. */
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

const A = process.argv[2];
const B = process.argv[3];
if (!A) { console.error("usage: node scripts/db-compare.mjs <ref-A> [ref-B]"); process.exit(2); }

/** Run SQL through the Supabase CLI, which uses the operator's own CLI login. */
function q(ref, sql) {
  /* shell:true is required for a .cmd shim on Windows. Without it execFileSync fails
     with an ENOENT-shaped dump that prints the whole argv and no useful reason. The SQL
     is passed through a temp file rather than the command line so quoting never has to
     survive two shells. */
  const tmp = `${process.env.TEMP || "/tmp"}/dbq-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`;
  writeFileSync(tmp, sql);
  let out;
  try {
    out = execFileSync(
      NPX,
      ["supabase", "db", "query", "--linked", "--project-ref", ref, "--output-format", "json", "-f", tmp],
      { encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, SUPABASE_ACCESS_TOKEN: "" } },
    );
  } finally { try { unlinkSync(tmp); } catch { /* best effort */ } }
  // The CLI wraps rows in a JSON envelope; find the first array of objects in it.
  const parsed = JSON.parse(out);
  const rows = parsed.rows ?? parsed.result ?? parsed.data ?? parsed;
  return Array.isArray(rows) ? rows : (rows.rows ?? []);
}

/* One query per object kind rather than a single joined one: a single query that
   errors tells you nothing about which half failed. */
const COUNTS = {
  tables:    `select count(*)::int as n from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`,
  views:     `select count(*)::int as n from information_schema.views where table_schema='public'`,
  functions: `select count(*)::int as n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public'`,
  policies:  `select count(*)::int as n from pg_policy`,
  triggers:  `select count(*)::int as n from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname='public' and not t.tgisinternal`,
  indexes:   `select count(*)::int as n from pg_indexes where schemaname='public'`,
  types:     `select count(*)::int as n from pg_type t join pg_namespace ns on ns.oid=t.typnamespace where ns.nspname='public' and t.typtype='e'`,
  columns:   `select count(*)::int as n from information_schema.columns where table_schema='public'`,
  fkeys:     `select count(*)::int as n from pg_constraint c join pg_namespace ns on ns.oid=c.connamespace where ns.nspname='public' and c.contype='f'`,
};

const NAMES = {
  tables:    `select table_name as name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1`,
  functions: `select proname as name from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' order by 1`,
  triggers:  `select t.tgname as name from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname='public' and not t.tgisinternal order by 1`,
};

const count = (ref) => Object.fromEntries(
  Object.entries(COUNTS).map(([k, sql]) => [k, q(ref, sql)[0]?.n ?? 0]),
);

const a = count(A);
if (!B) { console.log(JSON.stringify(a, null, 2)); process.exit(0); }
const b = count(B);

console.log(`\n${"object".padEnd(12)} ${A.slice(0, 8)}   ${B.slice(0, 8)}   diff`);
console.log("-".repeat(44));
let clean = true;
for (const k of Object.keys(COUNTS)) {
  const d = b[k] - a[k];
  if (d !== 0) clean = false;
  console.log(`${k.padEnd(12)} ${String(a[k]).padStart(8)}   ${String(b[k]).padStart(8)}   ${d === 0 ? "✅" : (d > 0 ? "+" : "") + d}`);
}

/* Name the missing objects. A count that is short by 14 is useless on its own —
   the whole point is knowing WHICH 14, so somebody can decide whether it matters. */
for (const [kind, sql] of Object.entries(NAMES)) {
  const inA = new Set(q(A, sql).map((r) => r.name));
  const inB = new Set(q(B, sql).map((r) => r.name));
  const missing = [...inA].filter((n) => !inB.has(n));
  const extra   = [...inB].filter((n) => !inA.has(n));
  if (missing.length) console.log(`\n${kind} in ${A} but NOT in ${B} (${missing.length}):\n  ${missing.join("\n  ")}`);
  if (extra.length)   console.log(`\n${kind} in ${B} but NOT in ${A} (${extra.length}):\n  ${extra.join("\n  ")}`);
}

console.log(clean ? "\n✅ Counts match on every object kind." : "\n⚠️  Differences above are real and unresolved.");
