import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * SQL test fixtures live in a reserved id namespace, and nothing else may.
 *
 * ─── THE FAILURE THIS PREVENTS ───────────────────────────────────────────────
 * `supabase/tests/*.sql` files create their own tenants, users and catalog rows
 * with hardcoded UUIDs, then roll back. That works right up until some OTHER
 * source of rows picks the same id. On 11 Sep 2026 four of the 53 files failed
 * against a local database for exactly that reason:
 *
 *   · `quote_accepted_on_first_payment` and `txn_category_rules` inserted tenants
 *     `1111…` and `2222…` — which `supabase/seed.sql` also creates, so the tests
 *     hit `duplicate key value violates unique constraint "tenants_pkey"`;
 *   · `sandbox_tenant_isolation` and `subscriptions_item_id` went the other way
 *     and BORROWED rows they did not create — a "ZZ TESTING SANDBOX" tenant, a
 *     real employee's user account, and one tenant's live catalog. None of those
 *     exist on a database built from `supabase/migrations`, so both died before
 *     asserting anything.
 *
 * Both directions are the same disease: a test whose result depends on rows it
 * does not own. The cure is that fixtures live at `7e57e57e-…` (hex-leet for
 * TESTEST, a convention this repo already had) and nothing else does.
 *
 * ─── WHY A SOURCE SCAN AND NOT A RUNTIME CHECK ───────────────────────────────
 * The failure mode is not an exception — it is a test that passes for the wrong
 * reason, or one that never ran because a fixture was missing. Only the absence
 * of a shared id can be asserted, and only before the SQL runs.
 */

const ROOT = process.cwd();
const TESTS_DIR = join(ROOT, "supabase", "tests");
const SEED = join(ROOT, "supabase", "seed.sql");

/** The reserved fixture namespace. */
const FIXTURE_PREFIX = "7e57e57e";

const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

/** Blank comments so an id mentioned in prose is not read as a fixture. */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, (m) => " ".repeat(m.length));
}

function uuidsIn(file: string): Set<string> {
  const body = stripSqlComments(readFileSync(file, "utf8"));
  return new Set((body.match(UUID_RE) ?? []).map((u) => u.toLowerCase()));
}

const testFiles = readdirSync(TESTS_DIR).filter((f) => f.endsWith(".sql")).sort();

describe("the SQL suite and the demo seed cannot fight over an id", () => {
  it("no test uses a UUID that seed.sql also creates", () => {
    /* The direction that produced the duplicate-key failures. It is checked
       against the seed's ACTUAL contents rather than a remembered list, so
       somebody adding a tenant to the seed finds out here instead of from four
       red tests they did not touch. */
    const seedIds = uuidsIn(SEED);
    expect(seedIds.size, "seed.sql has no UUIDs at all — has it moved?").toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const f of testFiles) {
      const shared = [...uuidsIn(join(TESTS_DIR, f))].filter((u) => seedIds.has(u));
      for (const u of shared) offenders.push(`${f}  ->  ${u}`);
    }
    expect(
      offenders,
      `These SQL tests use ids that supabase/seed.sql also creates, so they fail with a\n` +
        `duplicate key against any seeded database. Move the fixture into the reserved\n` +
        `${FIXTURE_PREFIX}- namespace:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("seed.sql stays out of the reserved fixture namespace", () => {
    /* The same rule from the other side. Without this, the fix above could be
       undone by a seed that helpfully creates a `7e57e57e-` tenant. */
    const inReserved = [...uuidsIn(SEED)].filter((u) => u.startsWith(`${FIXTURE_PREFIX}-`));
    expect(
      inReserved,
      `supabase/seed.sql uses the reserved SQL-fixture namespace ${FIXTURE_PREFIX}-, which\n` +
        `belongs to supabase/tests. Pick different ids:\n${inReserved.join("\n")}`,
    ).toEqual([]);
  });
});

describe("no SQL test depends on a real person or a live tenant", () => {
  /**
   * Ids that belong to production and must never appear in a test.
   *
   * Deliberately a SHORT, named list rather than a pattern: these are the two
   * that were actually being borrowed, and both caused a failure. A test that
   * needs a tenant or a user creates one — see `sandbox_tenant_isolation`, which
   * now builds both sides of the wall it measures.
   */
  const PRODUCTION_IDS: Record<string, string> = {
    "3caa0f07-44d1-42ee-91b3-2123e04853b1": "a real employee's user account",
    "fbb976f1-9090-4f10-9726-0901bd144e42": "the live buy-page tenant (BUY_PAGE_TENANT_ID)",
  };

  it.each(testFiles)("%s", (f) => {
    const used = uuidsIn(join(TESTS_DIR, f));
    const borrowed = Object.keys(PRODUCTION_IDS).filter((id) => used.has(id));
    expect(
      borrowed.map((id) => `${id} — ${PRODUCTION_IDS[id]}`),
      `${f} depends on rows it does not create. A test resting on production data either\n` +
        `fails where that data is absent, or passes because of something nobody promised to\n` +
        `keep. Create the fixture in the ${FIXTURE_PREFIX}- namespace instead.`,
    ).toEqual([]);
  });
});

describe("the reserved namespace is actually being used", () => {
  it("the four repaired files hold their fixtures in it", () => {
    /* A ratchet that only forbids things can be satisfied by a suite that has no
       fixtures at all. This pins the positive side for the files that were moved,
       so a future "simplification" back onto seeded or live ids is a red test
       rather than a quiet regression. */
    const shouldUse = [
      "quote_accepted_on_first_payment.test.sql",
      "txn_category_rules.test.sql",
      "sandbox_tenant_isolation.test.sql",
      "subscriptions_item_id.test.sql",
    ];
    for (const f of shouldUse) {
      const used = [...uuidsIn(join(TESTS_DIR, f))];
      expect(
        used.some((u) => u.startsWith(`${FIXTURE_PREFIX}-`)),
        `${f} should own its fixtures in the ${FIXTURE_PREFIX}- namespace`,
      ).toBe(true);
    }
  });
});
