/**
 * Are the migrations in git that the remote ledger does not list actually APPLIED?
 *
 *   node scripts/migration-drift-check.mjs        (or: npm run migrations:verify)
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `supabase migration repair --status applied <v>` writes "this ran" into the
 * ledger WITHOUT running anything. That is the correct tool when the ledger simply
 * lost track of work the database already has — and the wrong tool, silently, when
 * a migration genuinely never ran: it marks the change done, and every later reader
 * trusts a ledger that is now lying.
 *
 * On 19 Aug 2026 the handoff said all 30 untracked migrations were "tracking drift,
 * not missing changes". Running this proved 26 of them were. It also proved two were
 * NOT, and one of those was holding ₹8,165 of missing GST on an accepted quote. A
 * blanket repair would have buried it permanently.
 *
 * ─── WHAT IT DOES AND DOES NOT PROVE ─────────────────────────────────────────
 * It compares the OBJECTS each file creates — tables, columns, functions, triggers,
 * policies, indexes, types — against the live database. That covers schema.
 *
 * It CANNOT judge a data migration (an UPDATE, an INSERT, a `comment on`), because
 * those leave no object behind. Those are reported as **UNCLASSIFIED, and must be
 * read by hand** — deliberately, and not as PASS. A parser that quietly ignored what
 * it did not understand would hand out a clean bill of health for precisely the files
 * most worth reading, which is how the two unapplied ones would have slipped through.
 *
 * The reverse direction — objects in prod that git cannot recreate — is
 * `npm run backup:check`. Run both.
 */
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const MIG = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");
const QDIR = mkdtempSync(join(tmpdir(), "migration-drift-"));
let qn = 0;

/* Same transport as scripts/backup-db.mjs, for the same reason: the CLI is logged in
   and needs no token, while SUPABASE_ACCESS_TOKEN is malformed on this machine and
   the CLI reads it first. See docs/WORKING-ENVIRONMENT.md §2. */
function q(sql) {
  const f = join(QDIR, `q${qn++}.sql`);
  writeFileSync(f, sql, "utf8");
  const env = { ...process.env };
  delete env.SUPABASE_ACCESS_TOKEN;
  const r = spawnSync(`npx supabase db query --linked -f "${f}"`,
    { shell: true, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`supabase db query exited ${r.status}\n${(r.stderr || "").trim()}`);
  const o = JSON.parse(r.stdout);
  if (!Array.isArray(o.rows)) throw new Error(`no rows[] in CLI output:\n${r.stdout.slice(0, 300)}`);
  return o.rows;
}

const set = (sql) => new Set(q(sql).map((r) => String(r.k).toLowerCase()));

console.log("reading live inventory…");
const inv = {
  table:    set(`select tablename as k from pg_tables where schemaname='public'`),
  column:   set(`select table_name||'.'||column_name as k from information_schema.columns where table_schema='public'`),
  function: set(`select proname as k from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`),
  trigger:  set(`select tgname as k from pg_trigger where not tgisinternal`),
  policy:   set(`select policyname as k from pg_policies where schemaname='public'`),
  index:    set(`select indexname as k from pg_indexes where schemaname='public'`),
  type:     set(`select t.typname as k from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public'`),
};
for (const [k, v] of Object.entries(inv)) process.stdout.write(`  ${k} ${v.size}`);
console.log("\n");

/* Strip comments first. These files carry long prose headers that QUOTE the DDL they
   are and are not running; matching inside them invents objects that were never meant
   to exist and reports the file as broken. */
const strip = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*--.*$/gm, " ");

const RULES = [
  [/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi, "table"],
  [/alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?/gi, "column"],
  [/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z0-9_]+)"?/gi, "function"],
  [/create\s+(?:constraint\s+)?trigger\s+"?([a-z0-9_]+)"?/gi, "trigger"],
  [/create\s+policy\s+"?([^"\n]+?)"?\s+on\s/gi, "policy"],
  [/create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?/gi, "index"],
  [/create\s+type\s+(?:public\.)?"?([a-z0-9_]+)"?/gi, "type"],
];

const applied = [], broken = [], unclassified = [];

for (const file of readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort()) {
  const sql = strip(readFileSync(join(MIG, file), "utf8"));
  let present = 0;
  const missing = [];

  for (const [re, kind] of RULES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(sql)) !== null) {
      const key = kind === "column"
        ? `${m[1].toLowerCase()}.${m[2].toLowerCase()}`
        : m[1].toLowerCase();
      if (inv[kind].has(key)) present++; else missing.push(`${kind} ${key}`);
    }
  }

  if (missing.length) { broken.push({ file, present, missing }); console.log(`❌ ${file}  (${present} present, ${missing.length} MISSING)`); missing.forEach((x) => console.log(`      ${x}`)); }
  else if (present === 0) { unclassified.push(file); console.log(`❓ ${file}  — no schema objects; data/comment migration, READ IT BY HAND`); }
  else { applied.push(file); console.log(`✅ ${file}  (${present} objects, all present)`); }
}

console.log(`\n${applied.length} safe to repair · ${broken.length} with MISSING objects · ${unclassified.length} need a human`);
if (broken.length) console.log("\n⚠️  Do NOT repair the ❌ files — their objects are absent, so they never ran.");
if (unclassified.length) console.log("⚠️  A ❓ file leaves no object behind. Check its EFFECT in the data before repairing it.");

/* Exit non-zero when anything needs a decision, so this can gate a script later.
   Silence would make "nothing to do" and "I could not tell" look the same. */
process.exit(broken.length || unclassified.length ? 1 : 0);
