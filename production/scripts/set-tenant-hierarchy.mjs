/**
 * Set the reseller hierarchy: ANUTECH DIGITAL PVT LTD as the root distributor,
 * every other tenant as a managed child of it (migration 0040's columns).
 *
 * ─── WHAT THIS ACTUALLY ASSERTS ─────────────────────────────────────────────
 * `parent_tenant_id` is not a label. `0040_reseller_hierarchy.sql:12` defines it
 * as "this tenant buys wholesale from the referenced distributor", so setting it
 * is a commercial statement about those tenants, not tidying. It is reversible
 * (set it back to null) and touches no money row, but it should be run because
 * someone meant it, not because it made a diagram neater.
 *
 * Read-then-write with the service-role key, printing before/after, because the
 * read-only MCP server cannot issue an UPDATE.
 *
 *   node scripts/set-tenant-hierarchy.mjs           # dry run, shows the plan
 *   node scripts/set-tenant-hierarchy.mjs --apply   # writes
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnvLocal } from "./lib/env-local.mjs";

const APPLY = process.argv.includes("--apply");
const ROOT_ID = "fbb976f1-9090-4f10-9726-0901bd144e42"; // ANUTECH DIGITAL PVT LTD

/* Shared parser — this was six copies of a regex that stripped a quote off each
   END OF THE LINE, so a quoted value followed by a comment kept the comment.
   See scripts/lib/env-local.mjs for the error it produced. */
const env = loadEnvLocal();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: before, error } = await sb
  .from("tenants")
  .select("id, name, tier, parent_tenant_id")
  .order("created_at");
if (error) { console.error("read failed:", error.message); process.exit(1); }

const root = before.find((t) => t.id === ROOT_ID);
if (!root) { console.error(`Root tenant ${ROOT_ID} not found. Refusing to guess.`); process.exit(1); }

console.log("BEFORE");
for (const t of before) {
  console.log(`  ${t.name.padEnd(26)} tier=${String(t.tier).padEnd(12)} parent=${t.parent_tenant_id ?? "—"}`);
}

const children = before.filter((t) => t.id !== ROOT_ID);
console.log(`\nPLAN: ${root.name} → distributor, no parent`);
for (const c of children) console.log(`      ${c.name} → reseller, parent = ${root.name}`);

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to write.");
  process.exit(0);
}

// The root first: a child pointing at a tenant that is not yet a distributor
// would be inconsistent for however long the loop takes.
const { error: rootErr } = await sb
  .from("tenants")
  .update({ tier: "distributor", parent_tenant_id: null, updated_at: new Date().toISOString() })
  .eq("id", ROOT_ID);
if (rootErr) { console.error("root update failed:", rootErr.message); process.exit(1); }

for (const c of children) {
  const { error: e } = await sb
    .from("tenants")
    .update({ tier: "reseller", parent_tenant_id: ROOT_ID, updated_at: new Date().toISOString() })
    .eq("id", c.id);
  if (e) { console.error(`  FAILED ${c.name}: ${e.message}`); process.exit(1); }
}

const { data: after } = await sb
  .from("tenants")
  .select("id, name, tier, parent_tenant_id")
  .order("created_at");
console.log("\nAFTER");
for (const t of after) {
  const parent = t.parent_tenant_id ? after.find((x) => x.id === t.parent_tenant_id)?.name : "—";
  console.log(`  ${t.name.padEnd(26)} tier=${String(t.tier).padEnd(12)} parent=${parent}`);
}
