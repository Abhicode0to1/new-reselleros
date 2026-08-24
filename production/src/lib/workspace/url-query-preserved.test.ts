import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pushUrl, currentUrl } from "./history";
import type { TabHistory } from "./history";

/* ─────────────────────────────────────────────────────────────────────────────
   THE WORKSPACE MUST NOT DELETE QUERY STRINGS.

   Found 24 Aug 2026 while trying to reproduce a reported bug, and it turned out to BE the
   bug. The tab provider keeps the address bar in step with the active tab by calling
   `router.replace(<the tab's recorded url>)`. Two effects recorded that url as `pathname`
   alone. So every query string in the application was deleted by a navigation the user never
   asked for, a moment after arriving.

   It presented as an empty form. `/quotes/new?leadId=L-MT6S9CNF` became `/quotes/new`, the
   builder's lead mode switched off, and the quote saved with `lead_id = NULL` — a quote raised
   for a lead, attached to no lead, which no amount of "move the stage when a quote is sent"
   logic could ever place in the Quote Sent column. Measured both ways on the same lead:
   Q-ADPL-2026-27-0048 (before) has lead_id null, Q-ADPL-2026-27-0049 (after) has
   lead_id L-MT6S9CNF.

   The pure history layer was never at fault — it stores whatever string it is handed. So the
   unit tests below are about the CONTRACT, and the scan is about the caller, which is where
   the defect actually lived.
   ───────────────────────────────────────────────────────────────────────────── */

const empty: TabHistory = { stack: [], cursor: -1 };

describe("the history layer keeps a url whole", () => {
  it("stores the query string it is given", () => {
    const h = pushUrl(empty, "/quotes/new?leadId=L-MT6S9CNF&company=Saroj%20Tech");
    expect(currentUrl(h)).toBe("/quotes/new?leadId=L-MT6S9CNF&company=Saroj%20Tech");
  });

  it("treats the same path with different queries as two different places", () => {
    /* Otherwise Back from `?leadId=B` would land on `?leadId=A` and silently quote the wrong
       lead — the dedupe in pushUrl compares whole strings, and this pins that. */
    let h = pushUrl(empty, "/quotes/new?leadId=A");
    h = pushUrl(h, "/quotes/new?leadId=B");
    expect(h.stack).toEqual(["/quotes/new?leadId=A", "/quotes/new?leadId=B"]);
  });

  it("still dedupes a genuinely identical url", () => {
    let h = pushUrl(empty, "/leads?view=all");
    h = pushUrl(h, "/leads?view=all");
    expect(h.stack).toHaveLength(1);
  });
});

describe("the provider records the query string, not just the path", () => {
  const PROVIDER = readFileSync(
    join(process.cwd(), "src", "components", "providers", "workspace-tabs-provider.tsx"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("has a single helper for the full address", () => {
    expect(PROVIDER).toMatch(/pathname \+ window\.location\.search/);
  });

  it("adopts the current page WITH its query", () => {
    /* `url: pathname` here was half the bug. */
    expect(PROVIDER).toMatch(/type: "open", url: fullPath\(\)/);
    expect(PROVIDER).not.toMatch(/type: "open", url: pathname\b/);
  });

  it("records in-tab navigation WITH its query", () => {
    /* And `pushUrl(..., pathname)` was the other half — this is the one the sync effect reads
       back, so it is the one that actually did the deleting. */
    expect(PROVIDER).toMatch(/pushUrl\(h\[id\] \?\? emptyHistory, fullPath\(\)\)/);
    expect(PROVIDER).not.toMatch(/pushUrl\(h\[id\] \?\? emptyHistory, pathname\)/);
  });

  it("does not reach for useSearchParams, which would break the static marketing page", () => {
    /* Providers is mounted in the ROOT layout (app/layout.tsx), so a useSearchParams() here
       forces the marketing page dynamic and fails the build. Both call sites are effects
       gated on `hydrated`, so window.location is available and is the more direct truth. */
    expect(PROVIDER).not.toContain("useSearchParams");
  });

  it("keeps the tab TITLE derived from the path alone", () => {
    /* A tab labelled "/quotes/new?leadId=L-MT6S9CNF&company=..." is not a label. */
    expect(PROVIDER).toMatch(/title: titleForPath\(pathname\)/);
  });
});
