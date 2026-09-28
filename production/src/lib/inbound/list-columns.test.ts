import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_LIST_COLUMNS, INBOX_LIST_MAX_ROWS, idsNeedingHtml, withHtmlFallback } from "./list-columns";

/* S16: the inbox polls every 20s; the list must not carry every body_html on every poll. */

const cols = INBOX_LIST_COLUMNS.split(",").map((c) => c.trim());

describe("inbox list columns", () => {
  it("never selects body_html (or *) for the list", () => {
    expect(cols).not.toContain("body_html");
    expect(cols).not.toContain("*");
  });

  it("still carries every other column the page reads", () => {
    /* Every column of inbound_emails except body_html — read from the GENERATED types (S21:
       InboundEmailRow is now an alias of it) so a new column added by a migration and
       forgotten here fails this test. */
    /* CRLF → LF: Windows checkouts (`* text=auto`) get CRLF; CI/Linux gets LF. */
    const types = readFileSync(join(process.cwd(), "src", "lib", "supabase", "database.generated.ts"), "utf8").replace(/\r\n/g, "\n");
    const block = /\n {6}inbound_emails: \{\n {8}Row: \{([\s\S]*?)\n {8}\}/.exec(types)![1];
    const keys = [...block.matchAll(/^\s{10}([a-z_]+)\s*:/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(20);
    expect(cols.sort()).toEqual(keys.filter((k) => k !== "body_html").sort());
  });

  it("is bounded", () => {
    expect(INBOX_LIST_MAX_ROWS).toBeGreaterThan(0);
    expect(INBOX_LIST_MAX_ROWS).toBeLessThanOrEqual(500);
    const route = readFileSync(join(process.cwd(), "src", "app", "api", "inbound-emails", "route.ts"), "utf8");
    expect(route).toMatch(/\.select\(INBOX_LIST_COLUMNS\)/);
    /* S37: one row over the page, to know whether a next page exists — the route serves at
       most INBOX_LIST_MAX_ROWS (pageFromOverfetch; route.test.ts pins it). */
    expect(route).toMatch(/\.limit\(INBOX_LIST_MAX_ROWS \+ 1\)/);
    expect(route).toMatch(/pageFromOverfetch\([\s\S]{0,120}INBOX_LIST_MAX_ROWS,?\s*\)/);
  });
});

describe("html fallback, only where the page would use it", () => {
  const base = { body_text: null as string | null };
  it("asks for html only for rows with no readable text", () => {
    expect(idsNeedingHtml([
      { id: "a", body_text: "hello" },
      { id: "b", body_text: null },
      { id: "c", body_text: "   " },
      { id: "d", body_text: "" },
    ])).toEqual(["b", "c", "d"]);
  });

  it("puts html back on those rows and null on the rest", () => {
    const rows = [{ ...base, id: "a", body_text: "hi" }, { ...base, id: "b" }] as never[];
    const out = withHtmlFallback(rows, [{ id: "b", body_html: "<p>x</p>" }]);
    expect(out.map((r) => [r.id, r.body_html])).toEqual([["a", null], ["b", "<p>x</p>"]]);
  });
});

describe("hidden tabs do not poll", () => {
  const q = (f: string) => readFileSync(join(process.cwd(), "src", "lib", "queries", f), "utf8");
  it("inbox", () => {
    expect(q("inbound-emails.ts")).toMatch(/refetchIntervalInBackground\s*:\s*false/);
    expect(q("inbound-emails.ts")).not.toMatch(/refetchIntervalInBackground\s*:\s*true/);
  });
  it("whatsapp thread is bounded", () => {
    const src = q("whatsapp.ts");
    const at = src.indexOf("export function useWhatsAppThread");
    const body = src.slice(at, src.indexOf("\nexport ", at + 10));
    expect(body).toMatch(/\.limit\(WHATSAPP_THREAD_MAX\)/);
    expect(body).toMatch(/refetchIntervalInBackground\s*:\s*false/);
  });
});
