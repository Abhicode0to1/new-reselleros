/**
 * S40 guards for migration 20260929130000_lead_counts.sql — the pieces a SQL test alone
 * cannot hold:
 *
 *  1. supabase/tests/lead_counts.test.sql creates the functions from a pasted copy of the
 *     migration (so it runs on a database the migration has not reached and still rolls
 *     back). A copy that drifted would prove functions nobody runs (AGENTS.md L8).
 *  2. The SQL test's helper cases say what normPhone / normCompany / looksLikeJunk return.
 *     Those answers must be the TYPESCRIPT answers — so this file parses the same rows and
 *     runs the TS functions on them. The SQL side then holds the SQL functions to them.
 *  3. The list row the client types (LEAD_LIST_COLUMNS) is exactly what list_leads selects.
 *  4. The views and folders the SQL accepts are exactly the ones the page can send.
 *  5. Grants: authenticated only, invoker only.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LEAD_LIST_COLUMNS } from "./list-page";
import { normCompany, normPhone } from "./duplicates";
import { looksLikeJunk } from "./junk";
import { SALES_FLAGS, SALES_FOLDERS } from "./folders";

const ROOT = path.join(__dirname, "..", "..", "..");
const MIGRATION = path.join(ROOT, "supabase", "migrations", "20260929130000_lead_counts.sql");
const TEST = path.join(ROOT, "supabase", "tests", "lead_counts.test.sql");
const VIEWS_TSX = path.join(ROOT, "src", "components", "features", "leads", "leads-smart-views.tsx");
const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const norm = (s: string) => s.trim();

/** SQL literals of one `(...)` values row: 'text' ('' escapes '), null, true, false. */
function sqlRow(line: string): Array<string | boolean | null> {
  const out: Array<string | boolean | null> = [];
  const re = /'((?:[^']|'')*)'|\bnull\b|\btrue\b|\bfalse\b/g;
  for (const m of line.matchAll(re)) {
    if (m[1] !== undefined) out.push(m[1].replace(/''/g, "'"));
    else out.push(m[0] === "null" ? null : m[0] === "true");
  }
  return out;
}

function caseRows(label: string): Array<Array<string | boolean | null>> {
  const test = read(TEST);
  const start = test.indexOf(`-- >>> ${label}`);
  const end = test.indexOf(`-- <<< ${label}`);
  expect(start, `${label} start marker missing`).toBeGreaterThan(-1);
  expect(end, `${label} end marker missing`).toBeGreaterThan(start);
  return test.slice(start, end).split("\n").slice(1)
    .filter((l) => l.trim().startsWith("("))
    .map(sqlRow);
}

describe("lead_counts SQL test ↔ migration", () => {
  it("carries the migration verbatim between its COPY markers", () => {
    const test = read(TEST);
    const start = test.indexOf("-- >>> BEGIN COPY of supabase/migrations/20260929130000_lead_counts.sql");
    const end = test.indexOf("-- <<< END COPY of supabase/migrations/20260929130000_lead_counts.sql");
    expect(start, "BEGIN COPY marker missing").toBeGreaterThan(-1);
    expect(end, "END COPY marker missing").toBeGreaterThan(start);
    const copy = test.slice(test.indexOf("\n", start) + 1, end);
    expect(norm(copy), "supabase/tests/lead_counts.test.sql has drifted from the migration — re-paste it").toBe(norm(read(MIGRATION)));
  });

  it("rolls back and never commits", () => {
    const test = read(TEST);
    expect(test).toMatch(/^\s*rollback\s*;/im);
    expect(test).not.toMatch(/^\s*commit\s*;/im);
  });

  it("grants every function to authenticated only, and none runs as definer", () => {
    const s = read(MIGRATION);
    for (const sig of [
      "public.lead_counts(jsonb)", "public.list_leads(jsonb, integer, jsonb)",
      "public.lead_norm_phone(text)", "public.lead_norm_company(text)",
      "public.lead_looks_like_junk(text, text, text, text)",
    ]) {
      const esc = sig.replace(/[().]/g, "\\$&");
      expect(s).toMatch(new RegExp(`revoke all on function ${esc} from public;`));
      expect(s).toMatch(new RegExp(`revoke all on function ${esc} from anon;`));
      expect(s).toMatch(new RegExp(`grant execute on function ${esc} to authenticated;`));
    }
    expect(s.match(/^security invoker$/gm)?.length).toBe(2);
    expect(s).not.toMatch(/security definer/i);
  });
});

describe("the helper cases ARE the TypeScript answers", () => {
  it("normPhone", () => {
    const rows = caseRows("PHONE CASES");
    expect(rows.length).toBeGreaterThan(3);
    for (const [input, want] of rows) {
      expect(normPhone(input as string | null), `normPhone(${JSON.stringify(input)})`).toBe(want);
    }
  });

  it("normCompany", () => {
    const rows = caseRows("COMPANY CASES");
    expect(rows.length).toBeGreaterThan(3);
    for (const [input, want] of rows) {
      expect(normCompany(input as string | null), `normCompany(${JSON.stringify(input)})`).toBe(want);
    }
  });

  it("looksLikeJunk", () => {
    const rows = caseRows("JUNK CASES");
    expect(rows.length).toBeGreaterThan(5);
    for (const [company, contact_name, contact_email, contact_phone, want] of rows) {
      const got = looksLikeJunk({
        company: company as string, contact_name: contact_name as string | null,
        contact_email: contact_email as string | null, contact_phone: contact_phone as string | null,
      }).suspect;
      expect(got, `looksLikeJunk(${JSON.stringify([company, contact_name, contact_email, contact_phone])})`).toBe(want);
    }
  });
});

describe("what the client sends is what the SQL understands", () => {
  const sql = read(MIGRATION);

  it("list_leads selects exactly LEAD_LIST_COLUMNS — the client's row type is the server's row", () => {
    const from = sql.indexOf("  ), cand as (\n    select l.id");
    const sel = sql.slice(from, sql.indexOf("/* waitPriority as one stable number", from));
    const cols = [...sel.matchAll(/\bl\.([a-z_]+)/g)].map((m) => m[1]);
    expect(cols).toEqual([...LEAD_LIST_COLUMNS]);
    for (const heavy of ["notes", "requirement", "lost_note", "junk_note", "landing_page_url", "referrer_url"]) {
      expect(cols).not.toContain(heavy);
    }
  });

  it("both functions accept every View-menu view the page has, and no other", () => {
    const tsx = read(VIEWS_TSX);
    const union = tsx.match(/export type SmartView = ([^;]+);/)?.[1] ?? "";
    const ts = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(ts.length).toBeGreaterThan(10);
    const lists = [...sql.matchAll(/not in \(('everything'[^)]*)\)/g)].map((m) =>
      [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort());
    expect(lists.length, "list_leads and lead_counts each validate smart_view").toBe(2);
    for (const l of lists) expect(l).toEqual(ts);
  });

  it("both functions accept every folder and flag the page has, and no other", () => {
    const ts = ["all", ...SALES_FOLDERS.map((f) => f.id), ...SALES_FLAGS.map((f) => f.id)].sort();
    const lists = [...sql.matchAll(/v_folder not in \(([^)]*)\)/g)].map((m) =>
      [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort());
    expect(lists.length).toBe(2);
    for (const l of lists) expect(l).toEqual(ts);
  });
});
