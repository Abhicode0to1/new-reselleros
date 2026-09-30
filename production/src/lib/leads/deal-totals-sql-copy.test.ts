/**
 * Guards for migration 20260930200000_deal_totals_billing_cycle_dup_check.sql (R-070/71/72) —
 * the parts its SQL test cannot hold on its own:
 *
 *  1. supabase/tests/deal_totals_billing_dup.test.sql creates the functions from a pasted
 *     copy of the migration (so it runs on a database the migration has not reached and still
 *     rolls back). A copy that drifted would prove functions nobody runs.
 *  2. stage_totals' weighted ₹ uses the SAME probabilities as forecast.ts — the SQL CASE is
 *     parsed and compared with STAGE_PROBABILITY, so changing one without the other fails here.
 *  3. The re-created list_leads still selects exactly LEAD_LIST_COLUMNS, and both functions
 *     still accept exactly the page's views and folders.
 *  4. Grants: authenticated only, invoker only, for every function the file creates.
 *  5. The SQL key functions for email / GSTIN give the TS twins' answers
 *     (duplicate-check.ts#normEmail / normGstin) on the cases the SQL test asserts.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LEAD_LIST_COLUMNS } from "./list-page";
import { STAGE_PROBABILITY } from "./forecast";
import { SALES_FLAGS, SALES_FOLDERS } from "./folders";
import { normEmail, normGstin } from "./duplicate-check";

const ROOT = path.join(__dirname, "..", "..", "..");
const NAME = "20260930200000_deal_totals_billing_cycle_dup_check.sql";
const MIGRATION = path.join(ROOT, "supabase", "migrations", NAME);
const TEST = path.join(ROOT, "supabase", "tests", "deal_totals_billing_dup.test.sql");
const VIEWS_TSX = path.join(ROOT, "src", "components", "features", "leads", "leads-smart-views.tsx");
const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("deal_totals_billing_dup SQL test ↔ migration", () => {
  it("carries the migration verbatim between its COPY markers", () => {
    const test = read(TEST);
    const start = test.indexOf(`-- >>> BEGIN COPY of supabase/migrations/${NAME}`);
    const end = test.indexOf(`-- <<< END COPY of supabase/migrations/${NAME}`);
    expect(start, "BEGIN COPY marker missing").toBeGreaterThan(-1);
    expect(end, "END COPY marker missing").toBeGreaterThan(start);
    const copy = test.slice(test.indexOf("\n", start) + 1, end);
    expect(copy.trim(), "deal_totals_billing_dup.test.sql has drifted from the migration — re-paste it").toBe(read(MIGRATION).trim());
  });

  it("rolls back and never commits", () => {
    const test = read(TEST);
    expect(test).toMatch(/^\s*rollback\s*;/im);
    expect(test).not.toMatch(/^\s*commit\s*;/im);
  });
});

describe("the migration", () => {
  const sql = read(MIGRATION);

  it("weights stage_totals with forecast.ts's probabilities, every stage", () => {
    const block = sql.slice(sql.indexOf("'stage_totals', ("), sql.indexOf(") into v_out;"));
    const pairs = Object.fromEntries(
      [...block.matchAll(/when '([a-z]+)' then (\d+)/g)].map((m) => [m[1], Number(m[2])]),
    );
    const nonZero = Object.fromEntries(Object.entries(STAGE_PROBABILITY).filter(([, p]) => p > 0));
    expect(pairs).toEqual(nonZero);
    /* Every stage NOT listed falls to `else 0` — only right for the stages the TS gives 0. */
    expect(block).toMatch(/else 0 end\) \/ 100\)/);
    /* Rounded per deal, as weightedValue does — never round(sum × p). */
    expect(block).toMatch(/sum\(case when coalesce\(s\.value, 0\) > 0 then\s+round\(s\.value::numeric \*/);
  });

  it("won-mtd reads the win date in BOTH functions", () => {
    expect(sql.match(/v_view = 'won-mtd'[^\n]*\n?[^\n]*coalesce\([lf]\.stage_changed_at, [lf]\.created_at\)/g)?.length).toBe(2);
    expect(sql).not.toMatch(/'won-mtd'\s+and [lf]\.stage = 'won' and [lf]\.created_at >=/);
  });

  it("list_leads still selects exactly LEAD_LIST_COLUMNS", () => {
    const from = sql.indexOf("  ), cand as (\n    select l.id");
    const sel = sql.slice(from, sql.indexOf("/* waitPriority as one stable number", from));
    expect([...sel.matchAll(/\bl\.([a-z_]+)/g)].map((m) => m[1])).toEqual([...LEAD_LIST_COLUMNS]);
  });

  it("both functions accept every View-menu view and folder the page has, and no other", () => {
    const tsx = read(VIEWS_TSX);
    const views = [...(tsx.match(/export type SmartView = ([^;]+);/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    const vLists = [...sql.matchAll(/not in \(('everything'[^)]*)\)/g)].map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort());
    expect(vLists.length).toBe(2);
    for (const l of vLists) expect(l).toEqual(views);
    const folders = ["all", ...SALES_FOLDERS.map((f) => f.id), ...SALES_FLAGS.map((f) => f.id)].sort();
    const fLists = [...sql.matchAll(/v_folder not in \(([^)]*)\)/g)].map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort());
    expect(fLists.length).toBe(2);
    for (const l of fLists) expect(l).toEqual(folders);
  });

  it("grants every function to authenticated only, and none runs as definer", () => {
    for (const sig of [
      "public.lead_counts(jsonb)", "public.list_leads(jsonb, integer, jsonb)",
      "public.lead_norm_email(text)", "public.lead_norm_gstin(text)",
      "public.find_lead_duplicates(text, text, text, text, text)",
    ]) {
      const esc = sig.replace(/[().]/g, "\\$&");
      expect(sql).toMatch(new RegExp(`revoke all on function ${esc} from public;`));
      expect(sql).toMatch(new RegExp(`revoke all on function ${esc} from anon;`));
      expect(sql).toMatch(new RegExp(`grant execute on function ${esc} to authenticated;`));
    }
    expect(sql.match(/^security invoker$/gm)?.length).toBe(3);
    expect(sql).not.toMatch(/security definer/i);
  });

  it("is additive: nullable columns, a check on billing_cycle, no drop", () => {
    expect(sql).toMatch(/add column if not exists billing_cycle text;/);
    expect(sql).toMatch(/add column if not exists current_provider text;/);
    expect(sql).toMatch(/check \(billing_cycle is null or billing_cycle in \('monthly', 'yearly'\)\)/);
    expect(sql).not.toMatch(/\bdrop\s+(table|column|function|index)\b/i);
  });
});

describe("email / GSTIN keys: the TS twins give the SQL test's answers", () => {
  it("normEmail", () => {
    expect(normEmail("  Ravi@Alpha.IN ")).toBe("ravi@alpha.in");
    expect(normEmail("ravi")).toBe("");
    expect(normEmail("@x.in")).toBe("");
    expect(normEmail(null)).toBe("");
  });
  it("normGstin", () => {
    expect(normGstin(" 07abcde 1234f1z5 ")).toBe("07ABCDE1234F1Z5");
    expect(normGstin("07ABCDE")).toBe("");
    expect(normGstin(null)).toBe("");
  });
});
