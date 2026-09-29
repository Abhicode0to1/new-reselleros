/**
 * The SQL test creates list_leads() / list_whatsapp_threads() from a pasted copy of their
 * migration, so it can run on a database the migration has not reached and still roll
 * everything back. A copy that drifted would prove functions nobody runs (AGENTS.md L8) —
 * this is the guard that it has not. Also: the TS column list IS the migration's select list,
 * and the grants are what the header promises.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LEAD_LIST_COLUMNS } from "./list-page";

const ROOT = path.join(__dirname, "..", "..", "..");
const MIGRATION = path.join(ROOT, "supabase", "migrations", "20260928200000_list_rpcs.sql");
const TEST = path.join(ROOT, "supabase", "tests", "list_rpcs.test.sql");
const norm = (s: string) => s.replace(/\r\n/g, "\n").trim();
const sql = () => fs.readFileSync(MIGRATION, "utf8").replace(/\r\n/g, "\n");

describe("list_rpcs SQL test ↔ migration", () => {
  it("carries the migration verbatim between its COPY markers", () => {
    const test = fs.readFileSync(TEST, "utf8").replace(/\r\n/g, "\n");
    const start = test.indexOf("-- >>> BEGIN COPY of supabase/migrations/20260928200000_list_rpcs.sql");
    const end = test.indexOf("-- <<< END COPY of supabase/migrations/20260928200000_list_rpcs.sql");
    expect(start, "BEGIN COPY marker missing").toBeGreaterThan(-1);
    expect(end, "END COPY marker missing").toBeGreaterThan(start);
    const copy = test.slice(test.indexOf("\n", start) + 1, end);
    expect(norm(copy), "supabase/tests/list_rpcs.test.sql has drifted from the migration — re-paste it").toBe(norm(sql()));
  });

  it("rolls back and never commits", () => {
    const test = fs.readFileSync(TEST, "utf8");
    expect(test).toMatch(/^\s*rollback\s*;/im);
    expect(test).not.toMatch(/^\s*commit\s*;/im);
  });

  it("is granted to authenticated only, and runs as the caller", () => {
    const s = sql();
    for (const sig of ["public.list_leads(jsonb, integer, jsonb)", "public.list_whatsapp_threads(jsonb, integer)"]) {
      const esc = sig.replace(/[().]/g, "\\$&");
      expect(s).toMatch(new RegExp(`revoke all on function ${esc} from public;`));
      expect(s).toMatch(new RegExp(`revoke all on function ${esc} from anon;`));
      expect(s).toMatch(new RegExp(`grant execute on function ${esc} to authenticated;`));
    }
    expect(s.match(/^security invoker$/gm)?.length).toBe(2);
    expect(s).not.toMatch(/security definer/i);
  });

  it("S37's list_leads selected the leading columns of LEAD_LIST_COLUMNS", () => {
    /* S40 (20260929130000_lead_counts.sql) replaced list_leads and appended columns; the
       exact match against the LATEST body is in lead-counts-sql-copy.test.ts. This keeps
       S37's list honest: every column it served is still served, in the same order. */
    const s = sql();
    const sel = s.slice(s.indexOf("with page as (\n    select l.id"), s.indexOf("from public.leads l"));
    const cols = [...sel.matchAll(/\bl\.([a-z_]+)/g)].map((m) => m[1]);
    expect(cols.length).toBeGreaterThan(20);
    expect(cols).toEqual([...LEAD_LIST_COLUMNS].slice(0, cols.length));
    /* The heavy free text stays out. */
    for (const heavy of ["notes", "requirement", "lost_note", "junk_note", "landing_page_url", "referrer_url"]) {
      expect(cols).not.toContain(heavy);
    }
  });
});
