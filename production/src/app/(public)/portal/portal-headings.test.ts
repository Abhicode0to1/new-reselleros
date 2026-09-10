/**
 * Every page in the customer portal wears the same hat.
 *
 * ─── WHAT DRIFTED, AND WHY A TEST AND NOT JUST A FIX ────────────────────────
 * Measured 11 Sep 2026: ten portal pages carry a page title, and nine of them
 * used the identical pair of lines —
 *
 *     <h1 className="font-serif text-3xl md:text-4xl tracking-tight">…</h1>
 *     <p  className="text-sm text-ink-3 mt-1">…</p>
 *
 * `/portal/billing` alone used `text-2xl text-ink` and `mt-0.5`. On a desktop
 * that is a visible size jump — the title shrinks by roughly a third — the
 * moment a customer clicks Billing, and nothing announced it. It was almost
 * certainly the first of the pages to be written, and the pattern settled
 * afterwards without anybody going back.
 *
 * That is the exact shape of drift that a one-time fix does not hold: the next
 * page added to the portal has ten correct examples and one wrong one to copy
 * from, and no way to tell which is the house style. So the house style is
 * written down here, where a machine reads it.
 *
 * ─── THE RULE IS "STARTS WITH", NOT "EQUALS", ON PURPOSE ────────────────────
 * `/portal/support/new` appends `mt-2` because it sits under a back-link and
 * needs the breathing room. That is layout, not typography, and forbidding it
 * would make the guard something people work around rather than obey. What is
 * fixed is the type itself: family, size, responsive step, tracking.
 *
 * ─── ONE EXEMPTION, NAMED ───────────────────────────────────────────────────
 * `/portal/login` is not a portal page. It renders outside the shell, with no
 * nav and no signed-in customer, and it is centred in a card — a 4xl title
 * there would tower over the form. Exempting it by name rather than by pattern
 * keeps the exemption honest: the list cannot quietly grow.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/** The house style for a portal page title. Nine pages agreed on this. */
const CANONICAL_H1 = "font-serif text-3xl md:text-4xl tracking-tight";

/** The subhead that sits directly under it. */
const CANONICAL_SUBHEAD = "text-sm text-ink-3 mt-1";

/**
 * Not a portal page — see the header. Paths are relative to the portal root and
 * use forward slashes so this reads the same on Windows and Linux.
 */
const NOT_A_PORTAL_PAGE = ["login/page.tsx"];

const PORTAL_ROOT = join(process.cwd(), "src", "app", "(public)", "portal");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

interface Heading {
  /** Portal-relative, forward slashes. */
  file: string;
  className: string;
}

function portalHeadings(): Heading[] {
  const found: Heading[] = [];
  for (const full of walk(PORTAL_ROOT)) {
    const rel = full.slice(PORTAL_ROOT.length + 1).split("\\").join("/");
    if (NOT_A_PORTAL_PAGE.includes(rel)) continue;
    const src = readFileSync(full, "utf8");
    /* Only the double-quoted literal form. A className={cn(...)} on a portal
       h1 would not match and would therefore go unchecked — acceptable today
       because there are none, and the count assertion below is what would
       notice if a page stopped being seen. */
    for (const m of src.matchAll(/<h1\s+className="([^"]*)"/g)) {
      found.push({ file: rel, className: m[1] });
    }
  }
  return found;
}

describe("the customer portal's page titles are one typeface, one size", () => {
  const headings = portalHeadings();

  /* The denominator first. A scan that silently found nothing would pass every
     assertion below it, and this file would sit green while enforcing air. */
  it("actually parsed the portal's page titles", () => {
    expect(
      headings.length,
      "No <h1 className=\"…\"> found under src/app/(public)/portal — the scan is " +
        "broken or the pages moved, not that the portal has no titles.",
    ).toBeGreaterThanOrEqual(10);
  });

  it.each(portalHeadings())("$file wears the house title style", ({ file, className }) => {
    expect(
      className.startsWith(CANONICAL_H1),
      `${file}: the page title is "${className}".\n` +
        `Portal titles start with "${CANONICAL_H1}" — a customer moving between ` +
        `pages should not see the heading change size. Append a spacing utility ` +
        `if the layout needs one (support/new does), but leave the type alone.`,
    ).toBe(true);
  });

  /* ─── The subhead, checked only where one exists ───────────────────────────
     Not every page has a line under the title, and one is not required. What is
     required is that the ones which do have it use the same one — `mt-0.5` on
     Billing was the tell that its whole header block predated the pattern. */
  it("every subhead under a portal title uses the same one", () => {
    const offenders: string[] = [];
    for (const full of walk(PORTAL_ROOT)) {
      const rel = full.slice(PORTAL_ROOT.length + 1).split("\\").join("/");
      if (NOT_A_PORTAL_PAGE.includes(rel)) continue;
      const src = readFileSync(full, "utf8");
      /* The <p> that directly follows an <h1>, within the same header block.
         `[\s\S]{0,400}?` is lazy and bounded so this cannot run away and pair a
         title with a paragraph from halfway down the page. */
      for (const m of src.matchAll(/<h1[\s\S]{0,400}?<p\s+className="([^"]*)"/g)) {
        if (m[1] !== CANONICAL_SUBHEAD) offenders.push(`${rel}: "${m[1]}"`);
      }
    }
    expect(
      offenders,
      `A portal subhead differs from "${CANONICAL_SUBHEAD}":\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  /* ─── The page shell, which is the same drift one level out ────────────────
     Billing was missing this wrapper altogether, and the h1 class was only the
     visible half of that. Measured at 390px before the fix: the heading sat at
     x=0 — the words touching the edge of the phone — against 24px on the other
     nine. At 1280px it was worse: 0 instead of 124px, so Billing's content ran
     edge-to-edge across the browser while every other page was a centred
     1080px column.

     The max-width deliberately VARIES — 1080 for a listing, 800 for the
     profile form, 680 for the ticket form — so it is not part of the rule. The
     padding is: a portal page whose text can touch the screen edge is a bug on
     the device most of these customers are holding. */
  const SHELL = /max-w-\[\d+px\] mx-auto px-6 py-8/;

  it("every page with a title also carries the page shell", () => {
    const offenders: string[] = [];
    for (const file of new Set(headings.map((h) => h.file))) {
      const src = readFileSync(join(PORTAL_ROOT, file), "utf8");
      if (!SHELL.test(src)) offenders.push(file);
    }
    expect(
      offenders,
      `These portal pages have a title but no "max-w-[…px] mx-auto px-6 py-8" ` +
        `wrapper, so their text runs to the edge of the screen:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
