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
import { HIERARCHY_ENFORCED_IN_DATABASE } from "./enforcement";

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

  it("keeps the UI caveat in step with the policies that actually shipped", () => {
    /* The dangerous drift is the flag going true while the policies are still commented
       out: the "this only filters what you see" caveat disappears from /leads and /quotes,
       and a filter starts reading as privacy. Tying the two together means enabling one
       without the other fails here rather than on somebody's screen.

       Read RAW, not uncommented — an uncommented `create policy` at the start of a line is
       exactly what distinguishes shipped from staged. */
    const raw = readFileSync(MIGRATION, "utf8");
    const policiesShipped = /^[ \t]*create policy \w+_hierarchy_select/m.test(raw);

    expect(
      HIERARCHY_ENFORCED_IN_DATABASE,
      policiesShipped
        ? "Section 3b is uncommented but the UI still says visibility is not enforced"
        : "the UI claims database enforcement while Section 3b is still commented out",
    ).toBe(policiesShipped);
  });

  it("keeps the SQL regression test in step with the migration", () => {
    /* hierarchy_peer_isolation.test.sql creates the policies itself so it can prove them
       inside a rolled-back transaction. That is what makes it runnable before the migration
       is applied — and it is also how it could quietly start proving something the database
       does not do. Both files must use `as restrictive` and the same predicate. */
    const sqlTest = readFileSync(
      path.join(process.cwd(), "supabase", "tests", "hierarchy_peer_isolation.test.sql"),
      "utf8",
    );

    for (const kind of ["select", "update"]) {
      expect(
        sqlTest.replace(/\s+/g, " "),
        `the SQL test's ${kind} policy is not restrictive — it would pass against no policy at all`,
      ).toContain(`as restrictive for ${kind} using (public.can_see_record(owner_id))`);
    }

    /* The role switch is what makes RLS apply at all. A superuser connection bypasses every
       policy, so without this line the file is a very convincing no-op. */
    expect(sqlTest, "the SQL test never drops to the authenticated role")
      .toContain("set local role authenticated");

    /* It must not be able to leave fixtures behind on whatever database it is pointed at. */
    expect(sqlTest.trimEnd().endsWith("rollback;"), "the SQL test does not end in rollback").toBe(true);
    expect(sqlTest).not.toMatch(/^\s*commit;/m);
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
