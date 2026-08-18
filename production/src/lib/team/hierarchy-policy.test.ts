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
import { PEER_SCOPED_ROLES } from "./visibility";

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
    /* The dangerous drift is the flag going true while the policies are not actually
       running: the "this only filters what you see" caveat disappears from /leads and
       /quotes, and a filter starts reading as privacy.

       Keyed on the APPLIED marker, not on whether the SQL is commented out. That was the
       first design and it was wrong in a way worth remembering: it made "the text is
       uncommented" mean "the database enforces it", so staging a ready-to-run migration
       would have forced this flag true and put a false claim on screen. Written and running
       are different facts. A human edits the marker when they have run it. */
    const raw = readFileSync(MIGRATION, "utf8");
    const marker = /SECTION 3B APPLIED:\s*(yes|no)\b/i.exec(raw);
    expect(marker, "the SECTION 3B APPLIED marker is missing from the migration").toBeTruthy();

    const applied = marker![1].toLowerCase() === "yes";
    expect(
      HIERARCHY_ENFORCED_IN_DATABASE,
      applied
        ? "the migration says Section 3b is applied but the UI still says it is not enforced"
        : "the UI claims database enforcement while the migration says Section 3b is NOT applied",
    ).toBe(applied);
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

  it("keeps the paste-into-the-editor file in step with the migration", () => {
    /* A third copy of the policies exists because the CLI route failed on Pardeep's machine
       (a malformed SUPABASE_ACCESS_TOKEN) and the SQL editor needs no token. Convenient, and
       a drift hazard: the copy somebody actually PASTES is the one that must not go stale.
       Stale here means pasting a predicate the repo no longer describes — and it would look
       like it worked. */
    const applyFile = readFileSync(
      path.join(process.cwd(), "supabase", "apply", "SECTION3-paste-into-sql-editor.sql"),
      "utf8",
    );
    const migration = readFileSync(MIGRATION, "utf8");

    const predicate = (sql: string): string | undefined =>
      /create or replace function public\.can_see_record\(p_owner uuid\)[\s\S]*?as \$\$([\s\S]*?)\$\$/
        .exec(sql)?.[1]
        .replace(/\s+/g, " ")
        .trim();

    expect(predicate(applyFile), "the paste file's predicate differs from the migration's")
      .toBe(predicate(migration));

    /* All nine policies, and every one restrictive — the same invariant as the migration.
       A permissive copy in the file people paste is the worst place for it to hide. */
    for (const table of ["leads", "quotes", "customers"]) {
      for (const kind of ["select", "write", "delete"]) {
        expect(applyFile, `the paste file is missing ${table}_hierarchy_${kind}`)
          .toContain(`create policy ${table}_hierarchy_${kind}`);
      }
    }
    const permissiveCopies = applyFile
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => /^create policy \w+_hierarchy_/i.test(s))
      .filter((s) => !/as restrictive/i.test(s));
    expect(permissiveCopies, "a policy in the paste file is not restrictive").toEqual([]);

    /* No verify SELECT in the runnable part — it would execute inside the same uncommitted
       transaction, see the new policies, and report success for a change that may vanish
       (CLAUDE.md §25.6). The verify query lives in this file as a comment, which is why the
       check is on uncommented lines only. */
    const runnable = applyFile
      .split(/\r?\n/)
      .filter((l) => !/^\s*--/.test(l))
      .join("\n");
    expect(runnable.toLowerCase(), "the paste file runs a verify SELECT in the same transaction")
      .not.toMatch(/select .*pg_policies/);
  });

  it("scopes the same roles in TypeScript as in SQL", () => {
    /* The screen filters with PEER_SCOPED_ROLES; the database filters with the role branch
       of can_see_record(). If they disagree, the UI hides rows the API would serve — a page
       that looks empty for no reason, with no error anywhere to explain it. That is how the
       first version of this feature would have shown support staff zero leads. */
    /* ⚠️ ANCHORED ON THE RUNNABLE STATEMENT, and the first version of this test was not.
       It searched the whole file, matched the shell-pasteable copy in the §3a comment first,
       and passed while the real `as $$ … $$` body said something different. Proven by
       dropping `manager` from the real body: the test stayed green. A guard that validates
       documentation instead of the SQL is worse than no guard, because it is trusted. */
    const raw = readFileSync(MIGRATION, "utf8");
    const runnable = /create or replace function public\.can_see_record\(p_owner uuid\)[\s\S]*?as \$\$([\s\S]*?)\$\$/
      .exec(raw)?.[1];
    expect(runnable, "the runnable can_see_record body is missing").toBeTruthy();

    const rolesIn = (sql: string): string[] => {
      const branch = /u\.role not in \(([^)]*)\)/.exec(sql);
      expect(branch, "can_see_record has no role branch — did it revert to = 'owner'?").toBeTruthy();
      return branch![1].split(",").map((r) => r.trim().replace(/'/g, "")).sort();
    };

    expect(rolesIn(runnable!), "the runnable SQL scopes different roles than the UI")
      .toEqual([...PEER_SCOPED_ROLES].sort());

    /* The copy-paste command in the header must agree too — it is what somebody will
       actually run, and its quotes are doubled for the shell, hence the same stripping. */
    const shellCopy = /npx supabase db query[^\n]*can_see_record[^\n]*/.exec(raw)?.[0];
    expect(shellCopy, "the §3a shell command is missing").toBeTruthy();
    expect(rolesIn(shellCopy!), "the pasteable command disagrees with the migration body")
      .toEqual([...PEER_SCOPED_ROLES].sort());
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
