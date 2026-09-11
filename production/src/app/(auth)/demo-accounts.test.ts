/**
 * The dev login box must not name an account that does not exist.
 *
 * ─── THE ROT THIS PREVENTS ──────────────────────────────────────────────────
 * The box carried a third entry until 26 Aug 2026 — `darshan@exceltechnologies.in`
 * — for a user who was NOT in the database. Clicking it only ever failed, and
 * the comment above the list claimed it was "kept in sync with the actual
 * tenants in Supabase", which is the sort of promise a comment cannot keep.
 *
 * A third entry is back (11 Sep 2026, Pardeep: "beside these add a seperate
 * account just for testing with Hosting and Domain Customer panel"), so the
 * same rot is available again. This test ties the entry to the seed script that
 * creates it: the address has to appear in BOTH files, so renaming it in one
 * place breaks the build instead of leaving a button that does nothing.
 *
 * It reads source text rather than rendering the page, because what it is
 * guarding IS the source: two constants in two files that have to agree.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const LOGIN = readFileSync(join(ROOT, "src/app/(auth)/login/page.tsx"), "utf8");
const SEED = readFileSync(join(ROOT, "scripts/seed-portal-test-customer.sql"), "utf8");

/** Every email literal inside the DEMO_USERS array. */
function demoEmails(): string[] {
  const start = LOGIN.indexOf("const DEMO_USERS");
  expect(start, "DEMO_USERS not found — was the login page restructured?").toBeGreaterThan(-1);
  const end = LOGIN.indexOf("];", start);
  const block = LOGIN.slice(start, end);
  return [...block.matchAll(/email:\s*"([^"]+)"/g)].map((m) => m[1]);
}

describe("the dev demo-account list", () => {
  it("still has the three accounts, in one place", () => {
    const emails = demoEmails();
    expect(emails).toHaveLength(3);
    expect(emails).toContain("pardeep@anutech.in");
    expect(emails).toContain("pardeep@exceltechnologies.in");
    expect(emails).toContain("portal-test@anutech.invalid");
  });

  /* ─── THE TIE THAT STOPS THE DRIFT ────────────────────────────────────────
     The portal address is created by the seed script and checked by the login
     form's `portal_customer_exists` RPC against `customers.contact_email`. If
     the two files disagree by one character, the seeded customer exists under a
     different address and the portal refuses the login with "we don't
     recognise that email" — which reads as a broken portal, not a typo. */
  it("names the same portal address the seed script creates", () => {
    const emails = demoEmails();
    const portal = emails.filter((e) => e.endsWith(".invalid"));
    expect(portal, "the portal demo entry should use a .invalid address").toHaveLength(1);
    expect(SEED).toContain(portal[0]);
    /* And the seed must set it as contact_email, which is the column the RPC
       matches on — being present anywhere in the file is not enough. */
    expect(SEED).toMatch(new RegExp(`contact_email[\\s\\S]{0,400}${portal[0].replace(".", "\\.")}`));
  });

  /* A customer address must never be deliverable from a demo list. The two
     staff entries are real mailboxes that belong to us; a customer fixture is
     not, and `.invalid` (RFC 2606) can never resolve — so a stray cron or a
     test send cannot reach a stranger. */
  it("keeps the customer fixture undeliverable", () => {
    const portal = demoEmails().filter((e) => e.endsWith(".invalid"));
    expect(portal).toHaveLength(1);
  });

  /* ─── THE PORTAL ROW IS A DIFFERENT DOOR, NOT A MISSING PASSWORD ──────────
     The customer portal signs in with an emailed 6-digit code and has no
     password at all, and this form signs into the STAFF area, which
     `staff-area-guard` bounces a customer out of. So the entry must stay a LINK
     to /portal/login. Somebody "completing" it by adding a password field would
     produce a row that looks usable and cannot work. */
  it("links the portal entry to /portal/login instead of autofilling", () => {
    expect(LOGIN).toMatch(/portal:\s*true/);
    expect(LOGIN).toContain("/portal/login?email=");
    /* No password on the portal entry — checked by locating the object that
       carries `portal: true` and making sure it has no password key. */
    const start = LOGIN.indexOf("const DEMO_USERS");
    const block = LOGIN.slice(start, LOGIN.indexOf("];", start));
    const portalEntry = block.slice(
      block.lastIndexOf("{", block.indexOf("portal: true")),
      block.indexOf("}", block.indexOf("portal: true")) + 1,
    );
    expect(portalEntry).toContain("portal-test@anutech.invalid");
    /* The KEY, not the word. The row's own note reads "emailed code, no
       password", so searching for the bare word fails on its own copy — which
       is what the first version of this assertion did. */
    expect(portalEntry).not.toMatch(/password\s*:/);
  });

  /* The whole box is dev-only, and `NODE_ENV` is inlined at build time so the
     credentials are absent from a production bundle rather than merely hidden.
     Losing this check would publish two working staff passwords. */
  it("is gated on NODE_ENV, so production bundles carry no credentials", () => {
    expect(LOGIN).toMatch(/showDemoHint\s*=\s*process\.env\.NODE_ENV\s*!==\s*"production"/);
    expect(LOGIN).toMatch(/\{showDemoHint && configured &&/);
  });
});

describe("the seed script", () => {
  it("is a script, not a migration — demo rows must never reach production", () => {
    /* Asserted here rather than trusted: a seeded fake customer in production
       would show up in revenue reports and in the domain-expiry cron's mail. */
    expect(() =>
      readFileSync(join(ROOT, "scripts/seed-portal-test-customer.sql"), "utf8"),
    ).not.toThrow();
    const migrations = join(ROOT, "supabase/migrations");
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const names = readdirSync(migrations);
    expect(names.some((f) => f.includes("portal-test") || f.includes("portal_test"))).toBe(false);
  });

  it("proves itself against the RPC the login form actually calls", () => {
    /* The script ends by calling `portal_customer_exists` and raising if it
       says no. Without that, a schema change could leave the script "succeeding"
       while the login form still refuses the address. */
    expect(SEED).toContain("portal_customer_exists");
    expect(SEED).toMatch(/raise exception/i);
  });

  it("keeps the expiring-domain fixture relative to now(), not a fixed date", () => {
    /* A hard-coded date ages out of the notice window and the fixture quietly
       stops exercising the expiry path. */
    expect(SEED).toMatch(/now\(\)\s*\+\s*interval\s*'9 days'/);
  });

  it("uses the reserved fixture UUID namespace", () => {
    expect(SEED).toMatch(/7e57e57e-/);
  });
});
