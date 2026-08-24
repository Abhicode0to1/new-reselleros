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
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const OUT_DIR = process.argv[2];
if (!OUT_DIR) { console.error("usage: node dump.mjs <output-dir>"); process.exit(1); }

/* ─── Transport: the Supabase CLI, not the MCP server ─────────────────────────
   This used to spawn @supabase/mcp-server-supabase and speak JSON-RPC to it.
   That server authenticates with a PAT read from SUPABASE_ACCESS_TOKEN — and on
   the machine this actually runs on, that variable holds a malformed value. So
   every run returned {"error":{"message":"Unauthorized"}}, which the old parser
   turned into "rows(...).map is not a function".

   Measured 19 Aug 2026. The last good dump is 13 Aug, and this project is on the
   Supabase free plan with no PITR and no automatic backups — so a backup script
   that quietly stopped working IS the whole safety net gone. That is the reason
   this file changed transport rather than being patched.

   The CLI needs no token: `npx supabase login` is already done, which is why
   every other database task in this repo goes through it. `env -u` is required
   for the same reason as everywhere else — the CLI reads that malformed variable
   in preference to its own stored login. See docs/WORKING-ENVIRONMENT.md §2.

   The query goes via a temp FILE, not the command line: these statements contain
   quotes, semicolons and `*`, and this has to run through a shell on Windows to
   reach npx at all. A path is the one argument that cannot be re-parsed. */
const QDIR = mkdtempSync(join(tmpdir(), "resellersos-backup-"));
let qn = 0;

function sql(query) {
  const qfile = join(QDIR, `q${qn++}.sql`);
  writeFileSync(qfile, query, "utf8");

  const env = { ...process.env };
  delete env.SUPABASE_ACCESS_TOKEN;

  const r = spawnSync(`npx supabase db query --linked -f "${qfile}"`,
    { shell: true, env, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });

  if (r.error) throw new Error(`supabase CLI could not start: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`supabase db query exited ${r.status}\n${(r.stderr || "").trim()}`);
  }
  return r.stdout;
}

/**
 * `supabase db query` prints one JSON object on stdout: { boundary, rows, warning }.
 *
 * ⚠️ EVERY FAILURE PATH HERE THROWS. It must. The previous version returned `[]`
 * whenever it could not parse, and its own comments record what that bought: a run
 * that wrote a "backup" containing zero tables, and later an Unauthorized error
 * that fell through as a plain object and surfaced as "rows(...).map is not a
 * function" — a message that says nothing about the actual cause.
 *
 * A backup is the one artefact where a quiet failure is worse than a loud one: it
 * is not read until the day the database is gone, and by then the empty file is
 * indistinguishable from a real one. Fail here, or do not fail at all.
 */
function rows(stdout) {
  let o;
  try {
    o = JSON.parse(stdout);
  } catch {
    throw new Error(`supabase db query returned non-JSON:\n${stdout.slice(0, 400)}`);
  }
  if (o?.error) throw new Error(`query failed: ${JSON.stringify(o.error)}`);
  if (!Array.isArray(o?.rows)) {
    throw new Error(`no rows[] in CLI output — shape changed?\n${JSON.stringify(o).slice(0, 400)}`);
  }
  return o.rows;
}

const CAP = 5000; // rows per table; the whole DB is ~1.2k rows today

try {
  const tables = rows(await sql(
    "select tablename from pg_tables where schemaname='public' order by tablename"
  )).map(t => t.tablename);

  mkdirSync(OUT_DIR, { recursive: true });

  /* ─── ONE QUERY FOR EVERY TABLE, NOT ONE PROCESS PER TABLE ─────────────────
     This loop used to run `sql()` once per table, and `sql()` spawns a shell that runs
     `npx supabase` — which is itself a node process that resolves and launches the CLI
     binary. With 112 tables plus the schema reads that is ~120 process launches per backup.

     Measured 24 Aug 2026, twice in a row: after a heavy session on this machine the launches
     start failing with `supabase db query exited 3221225794` — Windows 0xC0000142,
     STATUS_DLL_INIT_FAILED, which is what process creation returns once something is
     exhausted. Both runs died part-way and at DIFFERENT tables (one reached `subscriptions`,
     the next stopped at `referral_*`), which is the signature of cumulative exhaustion rather
     than a bad table. The CLI itself was fine throughout — a single `db query` run by hand
     returned exit 0 seconds later.

     So the fault was never the transport, it was the SHAPE: a backup whose cost grows with
     the table count will eventually stop working, on the free plan where this script is the
     only backup there is. And it fails at the worst possible moment — the end of a long day,
     which is exactly when somebody is about to apply a migration.

     One statement, built here from the table list, returning one row per table with its rows
     as jsonb. Postgres does the fan-out. A table that errors is still named — by Postgres, in
     the error — so nothing is lost from the per-table loop except the process launches.

     %I-style quoting is done with a doubled-quote escape rather than left to interpolation:
     these are identifiers read out of pg_tables, so they cannot contain anything exotic
     today, and a dump script is the wrong place to rely on that staying true. */
  const dataSql = tables
    .map((t) => {
      const ident = `"${t.replace(/"/g, '""')}"`;
      return (
        `select '${t.replace(/'/g, "''")}'::text as t, ` +
        `coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) as rows ` +
        `from (select * from public.${ident} limit ${CAP}) x`
      );
    })
    .join("\nunion all\n");

  const dataRows = rows(await sql(dataSql));

  const data = {};
  const manifest = [];
  let total = 0, truncated = [];

  /* Keyed off the TABLE LIST, not off what came back. A table missing from the result is a
     table the dump does not contain, and silently writing a file without it is precisely the
     quiet failure this script's own header refuses to allow. */
  const byTable = new Map(dataRows.map((r) => [r.t, r.rows]));
  for (const t of tables) {
    const r = byTable.get(t);
    if (!Array.isArray(r)) {
      throw new Error(
        `table "${t}" is in pg_tables but came back with no rows array — the dump would be ` +
        `missing it silently, so nothing was written`,
      );
    }
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
  /* ─── AND THE SEVEN SCHEMA READS BECOME ONE ────────────────────────────────
     Same reason as the data above: seven more process launches on a script that was dying of
     process launches. `jsonb_build_object` returns one row holding all seven, so the shapes
     are unchanged — this is a transport change, not a content change, and the file written is
     structurally identical to the dumps already in the folder.

     Every sub-select keeps its own note, because each one was added after something was found
     MISSING from a dump. */
  process.stdout.write("\n  -- schema --\n");
  const schemaRows = rows(await sql(`
    select jsonb_build_object(
      'columns', (
        select coalesce(jsonb_agg(to_jsonb(c) order by c.table_name, c.ordinal_position), '[]'::jsonb)
          from (select table_name, column_name, data_type, is_nullable, column_default,
                       ordinal_position
                  from information_schema.columns where table_schema='public') c),
      'policies', (
        select coalesce(jsonb_agg(to_jsonb(p) order by p.tablename, p.policyname), '[]'::jsonb)
          from (select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
                  from pg_policies where schemaname='public') p),
      'functions', (
        select coalesce(jsonb_agg(to_jsonb(f) order by f.proname), '[]'::jsonb)
          from (select p.proname, pg_get_functiondef(p.oid) as definition
                  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public') f),
      -- pg_trigger, NOT information_schema.triggers — the latter only shows triggers on
      -- tables the caller owns, so it silently returned 0 while 46 actually exist
      -- (handle_updated_at, the cross-tenant invoice mirror, task completion, …).
      'triggers', (
        select coalesce(jsonb_agg(to_jsonb(g) order by g.table_name, g.trigger_name), '[]'::jsonb)
          from (select c.relname as table_name, t.tgname as trigger_name,
                       pg_get_triggerdef(t.oid) as definition
                  from pg_trigger t
                  join pg_class c on c.oid = t.tgrelid
                  join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname='public' and not t.tgisinternal) g),
      'indexes', (
        select coalesce(jsonb_agg(to_jsonb(i) order by i.tablename, i.indexname), '[]'::jsonb)
          from (select tablename, indexname, indexdef
                  from pg_indexes where schemaname='public') i),
      -- Constraints (PK / FK / UNIQUE / CHECK) with their full DDL. Without these the backup
      -- records a table's columns but not its RULES, and 11 tables exist in prod that git
      -- cannot recreate, so this is the only place their definition survives.
      'constraints', (
        select coalesce(jsonb_agg(to_jsonb(k) order by k.table_name, k.name), '[]'::jsonb)
          from (select c.conrelid::regclass::text as table_name, c.conname as name,
                       c.contype::text as type, pg_get_constraintdef(c.oid) as definition
                  from pg_constraint c
                  join pg_namespace n on n.oid = c.connamespace
                 where n.nspname='public') k),
      'migrations_applied', (
        select coalesce(jsonb_agg(to_jsonb(m) order by m.version), '[]'::jsonb)
          from (select version, name from supabase_migrations.schema_migrations) m)
    ) as schema
  `));

  const schema = schemaRows[0]?.schema;
  /* Fail loudly rather than write a dump with no schema in it. A restore needs the policies
     and the function bodies; a file that merely looks complete is the exact failure this
     script's header refuses to allow. */
  if (!schema || typeof schema !== "object") {
    throw new Error(
      "the schema query returned no object — nothing was written. Got: " +
      JSON.stringify(schemaRows).slice(0, 300),
    );
  }
  for (const key of ["columns", "policies", "functions", "triggers", "indexes",
                     "constraints", "migrations_applied"]) {
    if (!Array.isArray(schema[key])) {
      throw new Error(`schema.${key} is missing from the dump — nothing was written`);
    }
  }

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
