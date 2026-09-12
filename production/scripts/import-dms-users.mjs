/**
 * Import DMS's customer contacts into `customers`.
 *
 *   node scripts/import-dms-users.mjs --tenant <uuid>            # DRY RUN
 *   node scripts/import-dms-users.mjs --tenant <uuid> --apply    # writes
 *
 * ─── WHY ONLY CONTACTS ───────────────────────────────────────────────────────
 * The DMS Atlas snapshot was measured before this was written (9 Sep 2026): 1,005
 * documents, and the transactional half is test data — one hosting account called
 * `tt.com`, a ₹2 trial order and a ₹599.88 renewal carrying invoice numbers that
 * would land foreign entries in a GST-relevant series, non-integer prices where
 * our columns are integer rupees, and no cost price at all for a NOT NULL column
 * that feeds P&L. Contact records carry none of that. TASKS.md has the numbers.
 *
 * ─── DRY RUN IS THE DEFAULT, DELIBERATELY ────────────────────────────────────
 * This writes rows into a live customer table. It prints exactly what it would do
 * and changes nothing until `--apply`, because "I'll just run it and look" is how
 * an import gets discovered afterwards.
 *
 * ─── RE-RUNNABLE ─────────────────────────────────────────────────────────────
 * Matching is on lower-cased email within the tenant. A second run updates the
 * contact fields of a row it already created and inserts nothing new, so a
 * re-import after DMS changes is safe. It never deletes.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { mapDmsUser } from "../src/lib/dms/user-to-customer.ts";
import { loadEnvLocal } from "./lib/env-local.mjs";

const DMS_ROOT = process.env.DMS_ROOT?.trim() || "C:/xampp/htdocs/Domain-Management-Project";
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const tenantId = (argv[argv.indexOf("--tenant") + 1] || "").trim();

if (!argv.includes("--tenant") || !/^[0-9a-f-]{36}$/i.test(tenantId)) {
  console.error("usage: node scripts/import-dms-users.mjs --tenant <uuid> [--apply]");
  console.error("       the tenant is the reseller whose customers these are — DMS is Anutech's own");
  console.error("       domain business, so on production that is the ANUTECH DIGITAL tenant.");
  process.exit(2);
}

/* Next loads .env.local for the app; a standalone script does not, and adding
   dotenv for one file is a dependency nobody asked for. This file used to carry
   its own correct-but-separate parser — the quoting and trailing-comment rules,
   and the em-dash ByteString error behind them, now live in one place. */
const dotEnv = loadEnvLocal();
/* Service role, because this writes across a tenant the operator names rather
   than the one a session happens to be in. */
const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || dotEnv.NEXT_PUBLIC_SUPABASE_URL || "").trim();
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || dotEnv.SUPABASE_SERVICE_ROLE_KEY || "").trim();
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env.local).");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

/* DMS's own driver and connection string — nothing is installed here for this. */
const require_ = createRequire(import.meta.url);
const { MongoClient } = require_(path.join(DMS_ROOT, "node_modules", "mongodb"));
const envLocal = readFileSync(path.join(DMS_ROOT, ".env.local"), "utf8");
const mongoUri = (envLocal.match(/^MONGODB_URI=(.*)$/m) || [])[1]?.trim();
if (!mongoUri) {
  console.error(`No MONGODB_URI in ${DMS_ROOT}/.env.local`);
  process.exit(1);
}

const { data: tenant, error: tErr } = await db
  .from("tenants").select("id, name").eq("id", tenantId).maybeSingle();
if (tErr || !tenant) {
  console.error(`No such tenant ${tenantId}${tErr ? `: ${tErr.message}` : ""}`);
  process.exit(1);
}

console.log(`\nDMS user import — ${APPLY ? "APPLYING" : "DRY RUN (nothing will be written)"}`);
console.log(`  into tenant : ${tenant.name} (${tenant.id})`);
console.log(`  from        : ${mongoUri.replace(/(mongodb(\+srv)?:\/\/)[^@]*@/, "$1***:***@")}\n`);

const mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 20000 });
await mongo.connect();
const users = await mongo.db().collection("users").find({}).toArray();
await mongo.close();

const importedAt = new Date();
const skipped = [];
const planned = [];
for (const u of users) {
  const out = mapDmsUser(u, tenantId, importedAt);
  if (out.kind === "skip") skipped.push({ email: u.email ?? "(no email)", reason: out.reason });
  else planned.push(out);
}

console.log(`read ${users.length} DMS users → ${planned.length} to import, ${skipped.length} skipped\n`);
for (const s of skipped) console.log(`  SKIP  ${String(s.email).padEnd(38)} ${s.reason}`);
if (skipped.length) console.log("");

let inserted = 0, updated = 0, failed = 0;
for (const p of planned) {
  const { data: existing } = await db
    .from("customers").select("id, name")
    .eq("tenant_id", tenantId).ilike("contact_email", p.email).maybeSingle();

  const verb = existing ? "UPDATE" : "INSERT";
  const detail = [p.row.contact_phone && "phone", p.row.address && "address", p.row.gstin && "gstin"]
    .filter(Boolean).join("+") || "email only";
  console.log(`  ${verb}  ${p.email.padEnd(38)} ${p.row.name}  (${detail})`);

  if (!APPLY) continue;

  if (existing) {
    /* Contact fields only. `name` is left alone on purpose — somebody may have
       corrected it here, and a re-import should not undo that. */
    const { contact_first_name, contact_last_name, contact_phone, contact_mobile,
            address, city, state, pin_code, gstin, country, domain } = p.row;
    /* `country` and `domain` are included because both are NORMALISED from DMS
       rather than copied — "IN" becomes "India" so the country selector has an
       option to match, and a domain typed into companyName moves to its own
       column. A re-run should apply that repair to rows an earlier run wrote
       verbatim. `name` stays excluded: somebody may have corrected it here. */
    const { error } = await db.from("customers").update({
      contact_first_name, contact_last_name, contact_phone, contact_mobile,
      address, city, state, pin_code, gstin, country, domain,
    }).eq("id", existing.id);
    if (error) { console.error(`        failed: ${error.message}`); failed++; } else updated++;
  } else {
    const { error } = await db.from("customers").insert(p.row);
    if (error) { console.error(`        failed: ${error.message}`); failed++; } else inserted++;
  }
}

console.log("");
if (APPLY) {
  console.log(`Done. inserted ${inserted}, updated ${updated}, failed ${failed}.`);
  if (failed) process.exit(1);
} else {
  console.log("Dry run — nothing was written. Re-run with --apply to write these rows.");
}
