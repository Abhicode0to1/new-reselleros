/**
 * supabase/migrations/ is frozen at the Prisma Migrate baseline (prisma/migrations/0_init).
 * The deploy pipeline applies prisma/migrations only, so a new file in the old folder would
 * be committed, reviewed — and never reach the database. New migrations go in
 * prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const LAST_SUPABASE_MIGRATION = "20261005100000_feedback_filed_via_ai_chat.sql";

test("no new files in supabase/migrations (use prisma/migrations)", () => {
  const dir = join(__dirname, "..", "..", "..", "supabase", "migrations");
  const newer = readdirSync(dir).filter((f) => f.endsWith(".sql") && f > LAST_SUPABASE_MIGRATION);
  expect(newer).toEqual([]);
});

test("every Prisma migration folder holds a migration.sql and sorts after the baseline", () => {
  const dir = join(__dirname, "..", "..", "..", "prisma", "migrations");
  const folders = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  expect(folders[0]).toBe("0_init");
  for (const f of folders.slice(1)) {
    expect(f, "name must be <YYYYMMDDHHMMSS>_<name>").toMatch(/^\d{14}_[a-z0-9_]+$/);
    expect(readdirSync(join(dir, f))).toContain("migration.sql");
  }
});
