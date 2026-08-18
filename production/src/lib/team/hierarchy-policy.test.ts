/**
 * A guard on the SQL, not on TypeScript.
 *
 * ─── WHY A TEST READS A MIGRATION FILE ───────────────────────────────────────
 * The hierarchy policies were first written as ordinary PERMISSIVE policies. In that form
 * they could not have restricted anything: Postgres combines permissive policies with OR,
 * and `leads_select` / `quotes_select` / `customers_select` already grant the whole tenant.
 * "My team's rows" OR "every row" is every row.
 *
 * That mistake has no symptom. `create policy` succeeds, the migration reports success, the
 * app behaves exactly as before — and somebody reasonably concludes peer isolation is live.
 * An access-control change that silently no-ops is more dangerous than one that fails,
 * because a failure gets investigated.
 *
 * So the invariant is asserted in the only gate this repo actually runs on a feature branch
 * (CLAUDE.md §25.2: CI does not gate session branches; `npm run test` does, via the Stop
 * hook). The SQL regression tests in supabase/tests/ run by hand, which is not a gate.
 *
 * Comment markers are stripped before parsing, deliberately. The policies ship commented
 * out pending a business decision, and the moment somebody uncomments them is exactly when
 * this check has to have already been true.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260818150000_user_hierarchy_visibility.sql",
);

/** The file with SQL comment markers removed, so a commented-out policy is checked too. */
function uncommentedSql(): string {
  return readFileSync(MIGRATION, "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*--\s?/, ""))
    .join("\n");
}

function policyStatements(): string[] {
  return uncommentedSql()
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter((s) => /^create policy/i.test(s));
}

describe("hierarchy RLS policies", () => {
  it("declares every hierarchy policy AS RESTRICTIVE", () => {
    const hierarchy = policyStatements().filter((s) => /_hierarchy_/.test(s));
    expect(hierarchy.length).toBeGreaterThan(0);

    /* Named individually rather than counted, so the failure message says which policy
       would have been a no-op instead of "expected 9, got 8". */
    for (const statement of hierarchy) {
      const name = /^create policy (\S+)/i.exec(statement)?.[1] ?? statement.slice(0, 40);
      expect(statement.toLowerCase(), `${name} is PERMISSIVE — it cannot restrict anything`)
        .toContain("as restrictive");
    }
  });

  it("covers read AND write on all three tables", () => {
    /* A rep who cannot SELECT a peer's lead can still UPDATE it by id while leads_update
       stays tenant-wide. A blind write is worse than a read, so the write side is part of
       the invariant, not an optional extra. */
    const names = policyStatements()
      .map((s) => /^create policy (\S+)/i.exec(s)?.[1] ?? "")
      .filter((n) => n.includes("_hierarchy_"));

    for (const table of ["leads", "quotes", "customers"]) {
      for (const kind of ["select", "write", "delete"]) {
        expect(names, `${table} is missing its ${kind} policy`).toContain(`${table}_hierarchy_${kind}`);
      }
    }
  });

  it("never drops the tenant-wide policies it narrows", () => {
    /* Tenant isolation is the outer boundary. It has to survive any mistake in the inner
       one, which means this migration must not touch it — a restrictive policy ANDs on top
       and needs the permissive one to keep existing. */
    const sql = uncommentedSql().toLowerCase();
    for (const policy of ["leads_select", "quotes_select", "customers_select"]) {
      expect(sql).not.toContain(`drop policy if exists ${policy} `);
      expect(sql).not.toContain(`drop policy ${policy} `);
    }
  });

  it("exempts unclaimed rows and portal customers in the shared predicate", () => {
    const sql = uncommentedSql();
    /* Anchored on `as $$` rather than the first `$$` after the function name: the file
       also documents a shell-quoted form of the same statement, and prose about "$$ … $$"
       matched ahead of the real body. */
    const body = /create or replace function public\.can_see_record\(p_owner uuid\)[\s\S]*?as \$\$([\s\S]*?)\$\$/
      .exec(sql)?.[1];
    expect(body, "can_see_record is missing").toBeTruthy();

    /* Unclaimed rows are company data — without this branch, all 23 unowned quotes vanish
       from everybody's screen and it looks like data loss. */
    expect(body).toContain("p_owner is null");

    /* A portal customer is not in the reporting tree, so the tree test returns the empty
       set for them. Without this branch the public quote-accept page breaks for every
       quote that has an owner — and it breaks for the customer, not for us. */
    expect(body).toContain("current_customer_id() is not null");
  });
});
