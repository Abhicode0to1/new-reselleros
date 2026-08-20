/**
 * Rewrite the Org panel in dashboard.html from what the live database actually returns.
 *
 *   cd production && npm run org:sync            (add --check to only report drift)
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * dashboard.html is opened over file://, so it cannot query anything. Its org data has
 * to be baked in, and baked-in numbers rot: on 20 Aug 2026 a "measured on 19 Aug" lead
 * count was already wrong, because one lead had been created that morning. The number
 * looked exactly as trustworthy as it had the day before.
 *
 * So the panel is generated. Between the two ORG DATA markers, this script writes what
 * it measured; everything outside those markers is hand-written and derives its figures
 * from that data, so no prose has to be updated by hand either.
 *
 * ─── WHAT "MEASURED" MEANS HERE ──────────────────────────────────────────────
 * The `sees` number is NOT read off a policy. For each user the script becomes that
 * user inside one transaction -- `set local role authenticated` plus
 * `request.jwt.claims -> sub`, which is what auth.uid() reads -- and counts the leads
 * RLS hands back. A superuser connection would return everything and prove nothing.
 * The transaction ends in ROLLBACK: this script never writes to the database.
 *
 * Two numbers come back per person, and only one of them may be summed:
 *   own  -- leads they own. These partition the tenant's leads.
 *   sees -- leads RLS returns them. These OVERLAP; adding them is meaningless, which
 *           is why the panel labels them separately and says so.
 *
 * ─── EXIT CODES ──────────────────────────────────────────────────────────────
 *   0  dashboard.html now matches the database (or already did)
 *   1  something failed -- DB unreachable, markers missing, generated JS invalid
 *   2  --check only: the file is out of date (nothing was written)
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = resolve(HERE, "..", "..", "dashboard.html");

/* ANUTECH DIGITAL PVT LTD. Hard-coded as an ID on purpose: tenant names are derived from
   an email domain, so the wrong tenant reads as the right one, and two tenants exist here.
   Override with --tenant=<uuid>; never by name. */
const DEFAULT_TENANT = "fbb976f1-9090-4f10-9726-0901bd144e42";

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes("--check");
const TENANT = (args.find((a) => a.startsWith("--tenant=")) || "").split("=")[1] || DEFAULT_TENANT;
if (!/^[0-9a-f-]{36}$/i.test(TENANT)) {
  console.error(`--tenant must be a uuid, got "${TENANT}"`);
  process.exit(1);
}

const QDIR = mkdtempSync(join(tmpdir(), "org-chart-sync-"));
let qn = 0;

/* Same transport as scripts/migration-drift-check.mjs and scripts/backup-db.mjs, for the
   same reason: the CLI is already logged in and needs no token, while
   SUPABASE_ACCESS_TOKEN is malformed on this machine and the CLI reads it first.
   See docs/WORKING-ENVIRONMENT.md §2. Not piped -- a pipe would hide the exit code. */
function q(sql) {
  const f = join(QDIR, `q${qn++}.sql`);
  writeFileSync(f, sql, "utf8");
  const env = { ...process.env };
  delete env.SUPABASE_ACCESS_TOKEN;
  const r = spawnSync(`npx supabase db query --linked -f "${f}"`, {
    shell: true,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`supabase db query exited ${r.status}\n${(r.stderr || "").trim()}`);
  }
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    throw new Error(`CLI did not return JSON:\n${r.stdout.slice(0, 400)}`);
  }
  /* Throw on anything unparseable rather than degrading to []. backup-db.mjs used to
     return an empty array on a bad response and wrote a "0 tables" backup that looked
     fine for six days. */
  if (!Array.isArray(out.rows)) throw new Error(`no rows[] in CLI output:\n${r.stdout.slice(0, 400)}`);
  return out.rows;
}

/* One transaction, and the order of the two DO blocks is the whole trick.
 *
 * The roster is collected FIRST, while still on the privileged connection. Driving the
 * impersonation loop straight off `select ... from public.users` after `set local role
 * authenticated` looks right and is worthless: at that point there is no JWT yet, so
 * auth.uid() is null, RLS hides every row, the loop runs ZERO times, and the block
 * reports success having measured nobody. That is exactly how the first version of this
 * script (and verify-reporting-lines.sql) passed while proving nothing.
 *
 * Hence also the `iterated` counter: a measurement that skipped everyone must fail, not
 * come back empty and green. Counts are stashed in a session GUC because the CLI drops
 * NOTICE output and a temp table would be DDL.
 */
const SQL = `
begin;

do $$
declare roster jsonb;
begin
  select jsonb_agg(jsonb_build_object('id', id, 'email', email) order by email)
    into roster from public.users where tenant_id = '${TENANT}';
  if roster is null or jsonb_array_length(roster) = 0 then
    raise exception 'tenant ${TENANT} has no users -- wrong tenant id?';
  end if;
  perform set_config('org.roster', roster::text, true);
end $$;

set local role authenticated;

do $$
declare
  roster   jsonb := current_setting('org.roster')::jsonb;
  item     jsonb;
  n        integer;
  acc      jsonb := '{}'::jsonb;
  iterated integer := 0;
begin
  for item in select value from jsonb_array_elements(roster) loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', item->>'id', 'role', 'authenticated')::text, true);
    if auth.uid()::text <> (item->>'id') then
      raise exception 'impersonation did not take for %', item->>'email';
    end if;
    select count(*) into n from public.leads;
    acc := acc || jsonb_build_object(item->>'email', n);
    iterated := iterated + 1;
  end loop;
  if iterated <> jsonb_array_length(roster) then
    raise exception 'measured % of % people -- an empty loop must not pass',
      iterated, jsonb_array_length(roster);
  end if;
  perform set_config('org.sees', acc::text, true);
end $$;

reset role;

select jsonb_build_object(
  'tenant_name', (select name from public.tenants where id = '${TENANT}'),
  'total_leads', (select count(*) from public.leads where tenant_id = '${TENANT}'),
  'unowned_leads', (select count(*) from public.leads where tenant_id = '${TENANT}' and owner_id is null),
  'sees', current_setting('org.sees')::jsonb,
  'people', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', u.id, 'email', u.email, 'name', u.full_name, 'role', u.role,
      'manager_id', u.manager_id,
      'own', (select count(*) from public.leads l where l.owner_id = u.id)
    ) order by u.email), '[]'::jsonb)
    from public.users u where u.tenant_id = '${TENANT}'
  )
)::text as data;

rollback;
`;

console.log(`measuring tenant ${TENANT} …`);
const rows = q(SQL);
if (rows.length !== 1 || !rows[0].data) throw new Error(`unexpected result shape: ${JSON.stringify(rows).slice(0, 300)}`);
const db = JSON.parse(rows[0].data);

const people = db.people.map((p) => ({
  id: p.id,
  email: p.email,
  name: p.name || p.email,
  role: p.role,
  manager_id: p.manager_id,
  own: Number(p.own),
  sees: db.sees[p.email],
  children: [],
}));
if (!people.length) throw new Error(`tenant ${TENANT} has no users -- wrong tenant id?`);

const missing = people.filter((p) => typeof p.sees !== "number");
if (missing.length) throw new Error(`no measurement for: ${missing.map((p) => p.email).join(", ")}`);

/* Build the tree. A manager_id pointing outside the tenant, or a cycle, would otherwise
   silently drop people from the chart -- so both are errors, not quiet omissions. */
const byId = new Map(people.map((p) => [p.id, p]));
for (const p of people) {
  if (!p.manager_id) continue;
  const boss = byId.get(p.manager_id);
  if (!boss) throw new Error(`${p.email} reports to ${p.manager_id}, who is not in this tenant`);
  boss.children.push(p);
}
for (const p of people) {
  const seen = new Set([p.id]);
  let cur = p;
  while (cur.manager_id) {
    if (seen.has(cur.manager_id)) throw new Error(`manager chain cycles at ${p.email}`);
    seen.add(cur.manager_id);
    cur = byId.get(cur.manager_id);
  }
}
const rootless = people.filter((p) => !p.manager_id);
const roots = rootless.filter((p) => p.children.length);
const peers = rootless.filter((p) => !p.children.length);
const placed = new Set();
(function walk(list) {
  for (const p of list) {
    placed.add(p.id);
    walk(p.children);
  }
})(roots.concat(peers));
if (placed.size !== people.length) throw new Error(`${people.length - placed.size} people did not land in the chart`);

/* ---- render the JS block ------------------------------------------------- */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const now = new Date();
const asOf = `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;

const js = (v) => `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/* Order siblings by how much of the book sits under them, not by what they personally own.
   Sorting on `own` alone put a manager with one lead and no team above a manager with
   fifteen leads underneath her, which reads as a ranking and is the wrong one. */
const subtreeOwn = (p) => p.own + p.children.reduce((n, c) => n + subtreeOwn(c), 0);
const sortKids = (a, b) => subtreeOwn(b) - subtreeOwn(a) || b.own - a.own || a.name.localeCompare(b.name);

function person(p, indent) {
  const pad = " ".repeat(indent);
  const head =
    `${pad}{ name: ${js(p.name)}, email: ${js(p.email)}, role: ${js(p.role)}, ` +
    `own: ${p.own}, sees: ${p.sees}`;
  if (!p.children.length) return `${head}, children: [] }`;
  const kids = p.children
    .slice()
    .sort(sortKids)
    .map((c) => person(c, indent + 4))
    .join(",\n");
  return `${head},\n${pad}  children: [\n${kids}\n${pad}  ]\n${pad}}`;
}

const block = [
  `    const ORG_AS_OF = ${js(asOf)};`,
  `    const ORG_TENANT = ${js(db.tenant_name)};`,
  `    const ORG_TOTAL_LEADS = ${db.total_leads};`,
  ``,
  `    // own  = leads this person owns       (these partition the tenant's leads)`,
  `    // sees = leads RLS actually returned  (these overlap -- each is a filter of the same set)`,
  `    const ORG_ROOTS = [`,
  roots.slice().sort(sortKids).map((p) => person(p, 6)).join(",\n"),
  `    ];`,
  ``,
  `    // Manager-less people with nobody under them. They are PEERS of the roots above, not`,
  `    // children of them -- drawing them as children would invent a line the DB does not have.`,
  `    const ORG_PEERS = [`,
  peers.slice().sort(sortKids).map((p) => person(p, 6)).join(",\n"),
  `    ];`,
].join("\n");

/* ---- splice between the markers ----------------------------------------- */
const OPEN = ">>> ORG DATA";
const CLOSE = "<<< ORG DATA";
const original = readFileSync(DASHBOARD, "utf8");
const nl = original.includes("\r\n") ? "\r\n" : "\n";
const lines = original.split(/\r?\n/);
const iOpen = lines.findIndex((l) => l.includes(OPEN));
const iClose = lines.findIndex((l) => l.includes(CLOSE));
if (iOpen < 0 || iClose <= iOpen) {
  console.error(`could not find the ORG DATA markers in ${DASHBOARD}.`);
  console.error(`Expected a line containing "${OPEN}" and a later one containing "${CLOSE}".`);
  process.exit(1);
}

const updated = lines.slice(0, iOpen + 1).concat(block.split("\n"), lines.slice(iClose)).join(nl);

/* Drift is judged on the DATA, never on the date. ORG_AS_OF changes every day this runs,
   so comparing whole blocks would report "out of date" daily on an unchanged tree -- and a
   check that cries wolf every morning is a check nobody reads. */
const withoutDate = (text) =>
  text
    .split(/\r?\n/)
    .filter((l) => !l.includes("ORG_AS_OF"))
    .join("\n");
const currentBlock = lines.slice(iOpen + 1, iClose).join("\n");
const dataChanged = withoutDate(block) !== withoutDate(currentBlock);

/* Never leave a broken dashboard behind: parse the whole inline script, and actually run
   the org module against a stub DOM, before writing anything. */
function validate(html) {
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error("no <script> block in dashboard.html");
  new vm.Script(m[1], { filename: "dashboard-inline.js" });
  const code = m[1];
  const a = code.indexOf("// ===== ORG CHART =====");
  const b = code.indexOf("// ===== TASKS FUNCTIONALITY =====");
  if (a < 0 || b <= a) throw new Error("org module not found in the inline script");
  let out = null;
  const ctx = {
    escapeHtml: (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    document: { getElementById: (id) => (id === "orgContent" ? { set innerHTML(v) { out = v; } } : null) },
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(code.slice(a, b) + "\nrenderOrg();", ctx);
  if (!out || !out.includes("org-node")) throw new Error("renderOrg() produced nothing usable");
  for (const p of people) {
    if (!out.includes(p.name)) throw new Error(`${p.email} is missing from the rendered chart`);
  }
  return out;
}

if (CHECK_ONLY) {
  if (!dataChanged) {
    console.log(`up to date — ${people.length} people, ${db.total_leads} leads (date not checked)`);
    process.exit(0);
  }
  console.error("OUT OF DATE — dashboard.html does not match the database. Run: npm run org:sync");
  process.exit(2);
}

if (updated === original) {
  console.log(`already current — ${people.length} people, ${db.total_leads} leads`);
  process.exit(0);
}

validate(updated);
writeFileSync(DASHBOARD, updated, "utf8");

const sum = people.reduce((n, p) => n + p.own, 0);
console.log(dataChanged ? `wrote ${DASHBOARD}` : `wrote ${DASHBOARD} (data unchanged, date refreshed)`);
console.log(`  as of        ${asOf}`);
console.log(`  tenant       ${db.tenant_name}`);
console.log(`  people       ${people.length}  (${roots.length} with reports, ${peers.length} standalone)`);
console.log(`  leads        ${db.total_leads}  (owned ${sum}, unowned ${db.unowned_leads})`);
for (const p of people.slice().sort((a, b) => b.sees - a.sees || a.email.localeCompare(b.email))) {
  console.log(`  ${p.email.padEnd(34)} own ${String(p.own).padStart(3)}   sees ${String(p.sees).padStart(3)}`);
}
if (sum !== db.total_leads) {
  console.log(`\nnote: owned (${sum}) != total (${db.total_leads}) — ${db.unowned_leads} lead(s) have no owner,`);
  console.log(`      and an unowned lead is visible to everyone. The panel says so too.`);
}
