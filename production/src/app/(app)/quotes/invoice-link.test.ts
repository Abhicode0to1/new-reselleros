/**
 * A button that names one invoice must open that invoice.
 *
 * ─── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────
 * The quote detail page rendered `View invoice INV-ADPL-2026-27-0018` and linked to
 * `/invoices` — the whole list, 21 rows, find it yourself. Asked about on 21 Aug 2026:
 * "does this take you to the right place, is it logical?" It did not, and it was not.
 *
 * The exact destination already existed. `/invoices?open=<id>` auto-opens that invoice's
 * dialog, and five other call sites already used it: the Quotes LIST's own Invoiced
 * button, the payments page, the customer panel, the command palette, and the invoices
 * page's copy-link. So this was one screen out of step with the rest of the app, which is
 * precisely why it read as broken rather than unfinished — everything else did it right.
 *
 * ─── THE RULE ───────────────────────────────────────────────────────────────
 * If a file puts the singular words "View invoice" on screen, that file must also know how
 * to deep-link to one (`/invoices?open=`). The alternative to this rule is remembering,
 * across five files, and the record shows that does not hold.
 *
 * A third site was left pointing at the quote hub on purpose: quote-action-bar.tsx says in
 * a comment that invoiced states "deliberately fall through to the hub, which loads the
 * authoritative payment history". Its LABEL was the lie, not its route, so the label was
 * changed instead — and this test would have caught it either way, which is the point of
 * writing the rule against the words rather than against the href.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) tsxFiles(full, out);
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Comments are not UI, and this scan learned that the hard way: the very comment written
 * to explain this fix contains the words "View invoice", so the first run flagged the file
 * it had just been used to correct. Block comments and whole-line `//` comments come out
 * before matching. Line comments are only stripped when they START a line, so a `https://`
 * inside a string survives.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const files = tsxFiles(SRC).map((file) => ({ file, src: stripComments(readFileSync(file, "utf8")) }));

describe("a control naming one invoice opens that invoice", () => {
  it("has files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('never says "View invoice" without knowing how to deep-link to one', () => {
    const offenders: string[] = [];
    for (const { file, src } of files) {
      /* Singular only. "View invoices" (plural — the subscriptions page listing a
         customer's invoices) is a list destination and correctly goes to the list. */
      if (!/["'>\s]View invoice(?!s)/.test(src)) continue;
      if (!/\/invoices\?open=/.test(src)) offenders.push(file);
    }
    expect(
      offenders,
      'link to `/invoices?open=<invoice id>` — it opens that invoice\'s dialog — or label the button for where it actually goes',
    ).toEqual([]);
  });

  it("still finds the two screens this was fixed on, so the rule is not scanning thin air", () => {
    const withDeepLink = files
      .filter(({ src }) => /\/invoices\?open=/.test(src))
      .map(({ file }) => file.replace(/\\/g, "/"));
    expect(withDeepLink.join("\n")).toMatch(/quotes\/\[id\]\/page\.tsx/);
    expect(withDeepLink.join("\n")).toMatch(/leads\/page\.tsx/);
    // And the ones that were already right, which is how the fix was found at all.
    expect(withDeepLink.length).toBeGreaterThanOrEqual(6);
  });
});
