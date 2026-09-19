import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_NAV } from "./nav";

/**
 * Every screen in the sidebar is behind the auth gate.
 *
 * ─── THIS HAS NOW HAPPENED THREE TIMES ───────────────────────────────────────
 * `middleware.ts` carries a `PROTECTED_PREFIXES` list and a comment telling you
 * to keep it in sync with `APP_NAV`: "any new section's prefix must be added here
 * for the auth gate + role guard to fire." The instruction is correct and it has
 * been missed repeatedly:
 *
 *   19 Aug 2026 — `/vault` and `/attendance/me` answered 200 to a request with no
 *                 session at all. Found by curling the live service after a deploy.
 *   11 Sep 2026 — `/assets/domains` and `/assets/hosting`, added on 9 Sep, had the
 *                 same gap. Found because a portal CUSTOMER's session reached the
 *                 operator console and the page rendered with their own rows.
 *
 * Both times RLS held and no data crossed a tenant. That is the reason it survives
 * unnoticed: nothing errors, nothing leaks, and the only symptom is a shell that
 * should have been a redirect. A comment has now failed to prevent this twice, so
 * it is a test.
 *
 * ─── WHY IT READS THE SOURCE ─────────────────────────────────────────────────
 * `PROTECTED_PREFIXES` is a module-private const in a Next middleware file, which
 * cannot be imported into a test environment (it pulls in `next/server` and the
 * edge runtime). The list is a literal array of string literals, so parsing it is
 * exact rather than approximate — and a parse that finds nothing fails loudly
 * below rather than passing vacuously.
 */

const MIDDLEWARE = join(process.cwd(), "src", "middleware.ts");

function protectedPrefixes(): string[] {
  const src = readFileSync(MIDDLEWARE, "utf8");
  const block = /const PROTECTED_PREFIXES\s*=\s*\[([\s\S]*?)\n\];/.exec(src);
  if (!block) return [];
  /* Only quoted entries, so the prose in the comments between them is ignored. */
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Every href in the sidebar.
 *
 * APP_NAV is a list of SECTIONS, each with an `items` array — not a recursive
 * `children` tree, which is what the first version of this walker assumed. It
 * found nothing and the "was actually parsed" assertion below caught it, which is
 * the only reason that assertion is there.
 */
function navHrefs(): string[] {
  const out: string[] = [];
  for (const section of APP_NAV) {
    for (const item of section.items ?? []) {
      if (typeof item.href === "string" && item.href.startsWith("/")) out.push(item.href);
    }
  }
  return [...new Set(out)];
}

describe("the sidebar and the auth gate agree", () => {
  it("the prefix list was actually parsed", () => {
    /* Without this, a rename of the const would make every assertion below pass
       by finding nothing to check — the failure mode that makes a guard worse
       than no guard. */
    const prefixes = protectedPrefixes();
    expect(prefixes.length, "PROTECTED_PREFIXES could not be read from src/middleware.ts").toBeGreaterThan(20);
    expect(prefixes).toContain("/dashboard");
  });

  it("the nav was actually parsed", () => {
    const hrefs = navHrefs();
    expect(hrefs.length, "APP_NAV yielded no hrefs").toBeGreaterThan(20);
  });

  it("every sidebar destination is covered by a protected prefix", () => {
    const prefixes = protectedPrefixes();
    const uncovered = navHrefs().filter(
      (href) => !prefixes.some((p) => href === p || href.startsWith(`${p}/`)),
    );
    expect(
      uncovered,
      `These screens are in the sidebar but NOT behind the auth gate, so the app shell\n` +
        `renders for a request with no staff session:\n` +
        uncovered.map((u) => `  ${u}`).join("\n") +
        `\nAdd the section prefix to PROTECTED_PREFIXES in src/middleware.ts.`,
    ).toEqual([]);
  });

  it("keeps /assets covered specifically", () => {
    /* Named because this is the one that was missing, and a regression here is a
       customer looking at the operator console again. */
    const prefixes = protectedPrefixes();
    for (const href of ["/assets/domains", "/assets/hosting"]) {
      expect(
        prefixes.some((p) => href.startsWith(p)),
        `${href} must be behind the auth gate`,
      ).toBe(true);
    }
  });
});
