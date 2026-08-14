/**
 * Change a tenant's `doc_code` — the short code embedded in every GST document
 * number it issues (migration 0054).
 *
 * ─── WHY THIS REFUSES UNLESS THE SERIES IS UNTOUCHED ────────────────────────
 * Under CGST Rule 46 an invoice series must be consecutive and unique per
 * supplier. Changing the code AFTER documents have been issued splits the series
 * in two — defensible if done at a fiscal-year boundary and documented, but it is
 * a compliance decision, not a rename. Before the first document it is free.
 *
 * So the script checks, and refuses if anything was issued: max(last_number) over
 * document_series plus a direct count of invoices / quotes / purchase orders /
 * credit notes / debit notes. Both, because a series row could be reset by hand
 * while the documents it numbered still exist.
 *
 *   node scripts/set-doc-code.mjs <tenant-id> <NEW_CODE>           # dry run
 *   node scripts/set-doc-code.mjs <tenant-id> <NEW_CODE> --apply
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const TENANT = process.argv[2];
const CODE   = process.argv[3];
const APPLY  = process.argv.includes("--apply");

if (!TENANT || !CODE) {
  console.error("usage: node scripts/set-doc-code.mjs <tenant-id> <NEW_CODE> [--apply]");
  process.exit(2);
}
if (!/^[A-Z][A-Z0-9]{1,5}$/.test(CODE)) {
  console.error(`Refusing "${CODE}". Use 2-6 upper-case letters/digits — it is printed on GST documents.`);
  process.exit(2);
}

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: tenant, error: tErr } = await sb
  .from("tenants").select("id, name, doc_code").eq("id", TENANT).single();
if (tErr) { console.error("tenant read failed:", tErr.message); process.exit(1); }

console.log(`tenant   : ${tenant.name}`);
console.log(`doc_code : ${tenant.doc_code ?? "(none)"}  ->  ${CODE}`);

// ── The gate ────────────────────────────────────────────────────────────────
const { data: series } = await sb
  .from("document_series").select("doc_type, last_number").eq("tenant_id", TENANT);
const issuedFromSeries = (series ?? []).reduce((m, r) => Math.max(m, r.last_number ?? 0), 0);

const DOC_TABLES = ["invoices", "quotes", "purchase_orders", "credit_notes", "debit_notes"];
let issuedDocs = 0;
for (const table of DOC_TABLES) {
  const { count, error } = await sb
    .from(table).select("*", { count: "exact", head: true }).eq("tenant_id", TENANT);
  if (error) {
    console.error(`  could not count ${table}: ${error.message}`);
    console.error("  Refusing to continue — an uncounted table could hide an issued document.");
    process.exit(1);
  }
  if (count) console.log(`  ${table}: ${count}`);
  issuedDocs += count ?? 0;
}

console.log(`\nseries high-water: ${issuedFromSeries}   documents on record: ${issuedDocs}`);

if (issuedFromSeries > 0 || issuedDocs > 0) {
  console.error(
    "\nREFUSING. This tenant has already issued documents, so changing the code would\n" +
    "split its GST series. If that is genuinely intended, do it at a fiscal-year\n" +
    "boundary and record the decision — not through this script.",
  );
  process.exit(1);
}

if (!APPLY) {
  console.log("\nNothing has been issued, so this change is free. Re-run with --apply to write.");
  process.exit(0);
}

const { data: after, error } = await sb
  .from("tenants")
  .update({ doc_code: CODE, updated_at: new Date().toISOString() })
  .eq("id", TENANT)
  .select("id, name, doc_code")
  .single();
if (error) { console.error("update failed:", error.message); process.exit(1); }

console.log(`\nAFTER: ${after.name} -> doc_code = ${after.doc_code}`);
