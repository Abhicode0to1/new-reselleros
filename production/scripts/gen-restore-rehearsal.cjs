/**
 * Restore-REHEARSAL ka SQL banata hai (audit A8, 1 Sep 2026).
 *
 * docs/BACKUP.md kehta tha: "rehearse one restore — until then the backup's
 * value is unproven." Ye script offsite JSON ke EK tenant ka payload lekar
 * aisi SQL file banata hai jo:
 *   1. har table ko `jsonb_populate_recordset(null::public.<t>, …)` se
 *      TYPED parse karti hai (CTAS me — generated-column insert ka jhamela
 *      nahi), scratch schema me;
 *   2. har table ki ginti backup ki ginti se milati hai (mismatch = raise);
 *   3. ROLLBACK karti hai — prod par koi nishaan nahi; load ka ho jana hi
 *      saboot hai.
 *
 * "File size mat dekho, per-table ginti dekho" — wahi niyam yahan code hai.
 */
const fs = require("fs");

const [backupPath, tenantId, outPath] = process.argv.slice(2);
if (!backupPath || !tenantId || !outPath) {
  console.error("usage: node gen-restore-rehearsal.cjs <backup.json> <tenant_id> <out.sql>");
  process.exit(1);
}

const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
const snap = (backup.snapshots ?? []).find((s) => s.tenant_id === tenantId);
if (!snap) {
  console.error("tenant not in backup:", tenantId);
  process.exit(1);
}

const TAG = "$rj9x$";
const tables = Object.entries(snap.payload)
  .filter(([, rows]) => Array.isArray(rows) && rows.length > 0)
  .sort(([a], [b]) => a.localeCompare(b));

let totalRows = 0;
const parts = [];
parts.push("begin;");
parts.push("create schema restore_rehearsal;");

for (const [table, rows] of tables) {
  if (!/^[a-z0-9_]+$/.test(table)) {
    console.error("odd table name, refusing:", table);
    process.exit(1);
  }
  const json = JSON.stringify(rows);
  if (json.includes(TAG)) {
    console.error("dollar-tag collision in", table);
    process.exit(1);
  }
  totalRows += rows.length;
  parts.push(
    `create table restore_rehearsal.${table} as ` +
    `select * from jsonb_populate_recordset(null::public.${table}, ${TAG}${json}${TAG}::jsonb);`,
  );
  parts.push(
    `do $$ declare n int; begin select count(*) into n from restore_rehearsal.${table}; ` +
    `if n <> ${rows.length} then raise exception 'RESTORE FAIL ${table}: % rows loaded, ${rows.length} in backup', n; end if; end $$;`,
  );
}

parts.push(
  `do $$ begin raise notice 'RESTORE REHEARSAL PASS: ${tables.length} tables, ${totalRows} rows typed-loaded from backup ${backup.ist_date}'; end $$;`,
);
parts.push("rollback;");

fs.writeFileSync(outPath, parts.join("\n") + "\n");
console.log(`written ${outPath}: ${tables.length} tables, ${totalRows} rows, tenant ${snap.tenant_name}`);
