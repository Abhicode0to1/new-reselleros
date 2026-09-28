/**
 * The SQL test creates today_inbox() from a pasted copy of its migration, so that it can
 * run on a database the migration has not reached and still roll everything back. A
 * copy that drifted would prove a function nobody runs (AGENTS.md L8) — this is the
 * guard that it has not.
 *
 * It also checks the migration against the kinds the page knows how to label, so a new
 * queue added in SQL cannot arrive as a raw database word on screen.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TODAY_KIND_META } from "./inbox";

const ROOT = path.join(__dirname, "..", "..", "..");
const MIGRATION = path.join(ROOT, "supabase", "migrations", "20260928160000_today_inbox.sql");
const TEST = path.join(ROOT, "supabase", "tests", "today_inbox.test.sql");

const norm = (s: string) => s.replace(/\r\n/g, "\n").trim();

describe("today_inbox SQL test ↔ migration", () => {
  it("carries the migration verbatim between its COPY markers", () => {
    const test = fs.readFileSync(TEST, "utf8").replace(/\r\n/g, "\n");
    const start = test.indexOf("-- >>> BEGIN COPY of supabase/migrations/20260928160000_today_inbox.sql");
    const end = test.indexOf("-- <<< END COPY of supabase/migrations/20260928160000_today_inbox.sql");
    expect(start, "BEGIN COPY marker missing").toBeGreaterThan(-1);
    expect(end, "END COPY marker missing").toBeGreaterThan(start);
    const copy = test.slice(test.indexOf("\n", start) + 1, end);
    expect(norm(copy), "supabase/tests/today_inbox.test.sql has drifted from the migration — re-paste it")
      .toBe(norm(fs.readFileSync(MIGRATION, "utf8")));
  });

  it("rolls back and never commits (scripts/test-sql.mjs refuses otherwise)", () => {
    const test = fs.readFileSync(TEST, "utf8");
    expect(test).toMatch(/^\s*rollback\s*;/im);
    expect(test).not.toMatch(/^\s*commit\s*;/im);
  });

  it("emits only kinds the page has a label for", () => {
    const sql = fs.readFileSync(MIGRATION, "utf8");
    // Every branch's first column is a quoted kind: (select 'task'::text, … / (select 'enquiry', …
    const kinds = [...sql.matchAll(/\(select '([a-z_]+)'(?:::text)?,/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThanOrEqual(12);
    for (const k of new Set(kinds)) expect(TODAY_KIND_META, `no label for SQL kind "${k}"`).toHaveProperty(k);
  });

  it("is granted to authenticated only", () => {
    const sql = fs.readFileSync(MIGRATION, "utf8");
    expect(sql).toMatch(/revoke all on function public\.today_inbox\(\) from public;/);
    expect(sql).toMatch(/revoke all on function public\.today_inbox\(\) from anon;/);
    expect(sql).toMatch(/grant execute on function public\.today_inbox\(\) to authenticated;/);
    expect(sql).toMatch(/^security invoker$/m);
  });
});
