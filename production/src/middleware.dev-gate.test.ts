import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────────
   Measured on production, 23 Aug 2026, with no session:

       GET /dev            404
       GET /dev/pdf-test   200

   CLAUDE.md §7 had claimed since May that dev pages are "NOT included in
   production builds (middleware redirect if NODE_ENV=production)". There was no
   such redirect anywhere in middleware.ts. /dev/pdf-test renders a sample tax
   invoice from hardcoded fixtures — including the fabricated GSTIN
   27AABCE9876D1Z3 that lib/invoices/supplier-identity.ts exists to keep off real
   documents — served publicly under the company's own domain.

   It surfaced while adding a page that deliberately crashes the browser, which in
   a public directory would have been a crash-on-demand endpoint for strangers.

   A source scan rather than a request test: the middleware's behaviour depends on
   NODE_ENV and a live deployment, and neither is available here. What can be
   pinned is that the gate exists and fails closed.
   ───────────────────────────────────────────────────────────────────────────── */

const mw = readFileSync(join(process.cwd(), "src", "middleware.ts"), "utf8");

describe("/dev is gated in production", () => {
  it("matches the whole /dev subtree, not just the index", () => {
    /* /dev returned 404 already (there is no page at the root); every real dev page is
       a child, so a check on the bare path would have gated nothing. */
    expect(mw).toMatch(/pathname === "\/dev"/);
    expect(mw).toMatch(/pathname\.startsWith\("\/dev\/"\)/);
  });

  it("gates on NODE_ENV=production", () => {
    expect(mw).toMatch(/NODE_ENV === "production"/);
  });

  it("fails CLOSED — an unset override still blocks", () => {
    /* `!== "1"` rather than a truthy check, so an empty or misspelled value blocks
       instead of opening. The whole point is that this was open by accident for months. */
    expect(mw).toMatch(/ALLOW_DEV_PAGES !== "1"/);
  });

  it("answers 404, not a redirect", () => {
    /* Same answer a nonexistent route gives, so the surface is not advertised. A
       redirect to /login would confirm the path exists and is merely protected. */
    expect(mw).toMatch(/status: 404/);
  });

  it("runs BEFORE the auth work", () => {
    /* Not an authorisation question: a dev page should not exist in production for
       anybody, signed in or not. Placing it after updateSession would also spend a
       round trip on a request about to be refused. */
    expect(mw.indexOf('startsWith("/dev/")')).toBeLessThan(mw.indexOf("await updateSession"));
  });
});

describe("the browser Sentry test page", () => {
  const page = readFileSync(
    join(process.cwd(), "src", "app", "dev", "sentry-client-test", "page.tsx"),
    "utf8",
  );

  it("throws during RENDER, not inside a click handler", () => {
    /* A throw inside onClick is swallowed by the event handler and never reaches the
       boundary — it would test nothing. The state flag makes the next render throw. */
    expect(page).toMatch(/if \(crash\) \{\s*\n\s*throw new Error/);
  });

  it("reports flushed, which is the fact that separates configured from working", () => {
    /* CLAUDE.md §22: captureException mints an event id locally and flush() returns
       false when no transport was initialised. Everything else looks identical. */
    expect(page).toContain("Sentry.flush(");
    expect(page).toContain("flushed");
    expect(page).toContain("clientReady");
  });

  it("reads the NEXT_PUBLIC_ variable, since it runs in the browser", () => {
    expect(page).toContain("NEXT_PUBLIC_SENTRY_DSN");
    expect(page).not.toMatch(/process\.env\.SENTRY_DSN/);
  });

  it("lives under /dev, so the gate above covers it", () => {
    /* Asserted by location: this test reads the file from src/app/dev/. A page that
       crashes on demand must not be reachable by strangers. */
    expect(page).toContain('"use client"');
  });
});
