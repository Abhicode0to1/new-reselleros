/**
 * Restore-readiness audit — answers "could we actually rebuild prod from this
 * backup?" WITHOUT needing a database. Run before investing in a live rehearsal,
 * because if the answer is no, the rehearsal just discovers that slowly.
 *
 * The assumed restore recipe is: create schema from git migrations, then insert
 * the backup's JSON data in FK order. This checks every step of that.
 */
import { readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";

const REPO = process.env.REPO_ROOT ?? "..";
const MIG = `${REPO}/supabase/migrations`;

const backupPath = execSync(`ls -t "${process.env.BACKUP_DIR ?? '../../resellersos-backups'}"/*.json`).toString().trim().split("\n")[0];
const b = JSON.parse(readFileSync(backupPath, "utf8"));
console.log("backup:", backupPath.split(/[\\/]/).pop());
console.log("taken :", b.taken_at_utc, "\n");

const prodTables = b.tables.map(t => t.table);
const withRows = b.tables.filter(t => t.rows > 0).map(t => t.table);

// ── 1. Can git's migrations even create these tables? ───────────────────────
const sqlText = readdirSync(MIG).filter(f => f.endsWith(".sql"))
  .map(f => readFileSync(`${MIG}/${f}`, "utf8")).join("\n").toLowerCase();

const creatable = new Set();
for (const m of sqlText.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/g)) {
  creatable.add(m[1]);
}

const notInGit = prodTables.filter(t => !creatable.has(t.toLowerCase()));
const notInGitWithData = notInGit.filter(t => withRows.includes(t));

console.log("=== 1. SCHEMA: can git rebuild the tables? ===");
console.log(`  tables in prod backup      : ${prodTables.length}`);
console.log(`  tables git can CREATE      : ${creatable.size}`);
console.log(`  in prod but NOT in git     : ${notInGit.length}`);
if (notInGit.length) {
  console.log(`  ...of those, HOLDING DATA  : ${notInGitWithData.length}`);
  for (const t of notInGitWithData) {
    const rows = b.tables.find(x => x.table === t).rows;
    console.log(`      !! ${t} (${rows} rows) — would have nowhere to go`);
  }
  const empty = notInGit.filter(t => !withRows.includes(t));
  if (empty.length) console.log(`  (empty ones, lower risk: ${empty.join(", ")})`);
}

// ── 2. Does the data match the captured columns? ────────────────────────────
console.log("\n=== 2. DATA: do rows match the captured schema? ===");
const colsByTable = {};
for (const c of b.schema.columns) (colsByTable[c.table_name] ??= new Set()).add(c.column_name);
let mismatches = 0;
for (const t of withRows) {
  const known = colsByTable[t];
  if (!known) { console.log(`  ?? ${t}: no column metadata captured`); mismatches++; continue; }
  const rowKeys = new Set(Object.keys(b.data[t][0] ?? {}));
  const extra = [...rowKeys].filter(k => !known.has(k));
  if (extra.length) { console.log(`  !! ${t}: data has columns not in schema: ${extra.join(", ")}`); mismatches++; }
}
console.log(mismatches === 0 ? "  OK — every populated table's rows match its captured columns" : `  ${mismatches} mismatch(es)`);

// ── 3. FK order — is a safe insertion order even possible? ──────────────────
console.log("\n=== 3. FK ORDER: can we compute a safe insert order? ===");
const fkPairs = [];
for (const m of sqlText.matchAll(/references\s+(?:public\.)?"?([a-z0-9_]+)"?/g)) fkPairs.push(m[1]);
const referenced = new Set(fkPairs);
console.log(`  distinct FK target tables referenced in migrations: ${referenced.size}`);
const authRefs = sqlText.match(/references\s+auth\.users/g)?.length ?? 0;
console.log(`  FK references to auth.users: ${authRefs}  <-- auth is NOT in the backup`);

// ── 4. What is simply absent ───────────────────────────────────────────────
console.log("\n=== 4. NOT IN THE BACKUP AT ALL ===");
console.log("  auth.users            : users' logins. public.users.id REFERENCES auth.users(id)");
console.log("  storage buckets       : tds-certificates, receipts, logos");
console.log("  sequences / counters  : document_series rows ARE captured (good), but any");
console.log("                          Postgres sequence values are not");
console.log(`  schema captured for reference: ${b.schema.policies.length} policies, ${b.schema.functions.length} functions, ${b.schema.triggers.length} triggers`);
