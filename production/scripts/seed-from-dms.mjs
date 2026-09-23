#!/usr/bin/env node
/**
 * Seed local ResellerOS customers that LINE UP with whatever DMS holds.
 *
 *   node scripts/seed-from-dms.mjs [--dms <path-to-dms-repo>] [--tenant <uuid>] [--apply]
 *
 * The integration is keyed on email: ResellerOS asks DMS
 * `GET /api/integrations/engine/services?email=…` and DMS answers with that
 * person's domains and hosting. So a ResellerOS customer whose `contact_email`
 * matches nothing in DMS gets `linked: false` — which is correct behaviour and
 * useless for exercising the feature.
 *
 * This reads DMS's LOCAL Mongo (via `docker compose exec`, because the Mongo
 * port is deliberately not published) and creates a matching ResellerOS
 * customer for each DMS user that owns a domain or hosting. It does not
 * invent emails: every row it writes comes from a real DMS user, so the link
 * is genuine rather than a fixture that agrees with itself.
 *
 * It works the same whether DMS holds the seeded fixtures or a restored
 * production dump — which is the point. Run it again after a restore and the
 * ResellerOS side follows.
 *
 * DEFAULTS TO A DRY RUN. Nothing is written without `--apply`, because this
 * points at a database that already has 13 customers somebody put there.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const APPLY = args.includes("--apply");
const DMS_REPO = resolve(flag("dms", "C:/xampp/htdocs/Domain-Management-Project"));
/** Anutech Digital — the tenant the local stack signs in as. */
const TENANT = flag("tenant", "22222222-2222-2222-2222-222222222222");
const PG_CONTAINER = "supabase_db_resellerosv3";

function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

if (!existsSync(DMS_REPO)) die(`DMS repo not found at ${DMS_REPO} — pass --dms <path>`);

// ─── 1. Read DMS ───────────────────────────────────────────────────────────
// Users who actually own something. A DMS user with no domain and no hosting
// has nothing for the engine API to return, so seeding a ResellerOS customer
// for them would produce a link that renders empty.
const MONGO_QUERY = `
const d = db.getSiblingDB("dms");
const out = [];
d.users.find({ email: { $ne: null } }).forEach((u) => {
  const domains  = d.domains.countDocuments({ userId: u._id, deletedAt: null });
  const hostings = d.hostings.countDocuments({ userId: u._id });
  if (domains + hostings === 0) return;
  out.push({
    email: String(u.email).toLowerCase(),
    firstName: u.firstName || "",
    lastName: u.lastName || "",
    companyName: u.companyName || "",
    phone: u.phone || "",
    gstNumber: u.gstNumber || "",
    domains, hostings,
  });
});
print(JSON.stringify(out));
`;

let dmsUsers;
try {
  const raw = execFileSync(
    "docker",
    ["compose", "exec", "-T", "mongo", "mongosh", "--quiet", "--eval", MONGO_QUERY],
    { cwd: DMS_REPO, encoding: "utf8" }
  );
  const line = raw.split(/\r?\n/).find((l) => l.trim().startsWith("["));
  if (!line) die(`could not parse mongosh output:\n${raw}`);
  dmsUsers = JSON.parse(line);
} catch (err) {
  die(
    `could not read DMS's Mongo. Is the DMS stack up? (docker compose up -d in ${DMS_REPO})\n  ` +
      (err instanceof Error ? err.message : String(err))
  );
}

if (dmsUsers.length === 0) {
  die(
    "DMS has no users who own a domain or hosting, so there is nothing to link to.\n" +
      "  Restore a dump first (scripts/restore-dump-local.mjs in the DMS repo),\n" +
      "  or seed DMS fixtures, then run this again."
  );
}

console.log(`  DMS users owning something: ${dmsUsers.length}`);
for (const u of dmsUsers.slice(0, 10)) {
  console.log(`    ${u.email.padEnd(38)} ${u.domains} domain(s)  ${u.hostings} hosting`);
}
if (dmsUsers.length > 10) console.log(`    … and ${dmsUsers.length - 10} more`);

// ─── 2. What already exists on the ResellerOS side ─────────────────────────
function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", "-i", PG_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", sql],
    { encoding: "utf8" }
  ).trim();
}

let existing;
try {
  existing = new Set(
    psql(`select lower(contact_email) from customers where tenant_id = '${TENANT}' and contact_email is not null`)
      .split(/\r?\n/)
      .filter(Boolean)
  );
} catch (err) {
  die(
    `could not reach local Supabase (${PG_CONTAINER}). Is it running? \`supabase start\`\n  ` +
      (err instanceof Error ? err.message : String(err))
  );
}

const missing = dmsUsers.filter((u) => !existing.has(u.email));
console.log(`\n  ResellerOS already has ${existing.size} customer email(s) for this tenant.`);
console.log(`  Missing the link for ${missing.length} of the ${dmsUsers.length} DMS users.`);

if (missing.length === 0) {
  console.log("\n  Nothing to do — every DMS owner already has a ResellerOS customer.\n");
  process.exit(0);
}

// ─── 3. Write ──────────────────────────────────────────────────────────────
const esc = (v) => `'${String(v ?? "").replace(/'/g, "''")}'`;
const nameFor = (u) =>
  u.companyName || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email.split("@")[0];

const values = missing
  .map(
    (u) =>
      `(gen_random_uuid(), ${esc(TENANT)}::uuid, ${esc(nameFor(u))}, ${esc(u.email)}, ` +
      `${u.phone ? esc(u.phone) : "null"}, ${u.gstNumber ? esc(u.gstNumber) : "null"}, ` +
      `${esc([u.firstName, u.lastName].filter(Boolean).join(" ") || u.email.split("@")[0])}, ` +
      `'Seeded from DMS so the hosting/domain link resolves. Safe to delete.', now(), now())`
  )
  .join(",\n    ");

const sql = `insert into customers
    (id, tenant_id, name, contact_email, contact_phone, gstin, contact_name, notes, created_at, updated_at)
  values
    ${values};`;

if (!APPLY) {
  console.log(`
  DRY RUN — nothing written. Would insert ${missing.length} customer(s):`);
  for (const u of missing) console.log(`    ${nameFor(u).padEnd(34)} ${u.email}`);
  console.log(`
  Re-run with --apply to write them.
`);
  process.exit(0);
}

try {
  psql(sql);
} catch (err) {
  die(`insert failed:\n  ${err instanceof Error ? err.message : String(err)}`);
}

const now = psql(`select count(*) from customers where tenant_id = '${TENANT}'`);
console.log(`
  Inserted ${missing.length}. This tenant now has ${now} customers.

  Check the link end to end:
    1. DMS up on 4310, ResellerOS on 4320
    2. Open /hosting-domains in ResellerOS and look up one of the emails above
    3. It should report the domain/hosting counts printed at the top of this run
`);
