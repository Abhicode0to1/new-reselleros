/**
 * The staff shell must keep wrapping its children in `StaffAreaGuard`.
 *
 * ─── WHY A STRUCTURAL TEST AND NOT A RENDER TEST ────────────────────────────
 * What this protects is not the component's logic — that is four lines and
 * browser-verified both ways (a portal customer gets the explanation; a staff
 * member gets the app and, measured, zero `customer_users` requests). What it
 * protects is the WIRING, because the wiring is the part that can disappear
 * without anybody noticing.
 *
 * `(app)/layout.tsx` covers more than thirty routes. If a refactor drops the
 * wrapper, every one of them silently returns to the old behaviour: a signed-in
 * portal customer sees the whole staff shell rendered around an empty page with
 * "No workspace yet" in the corner. Nothing errors, no test fails, and the person
 * who sees it is a customer who will not report it as a bug because it looks like
 * the product.
 *
 * A render test would need jsdom plus React Query plus a mocked Supabase client
 * to assert something the browser already answered. This asserts the one fact
 * that a future edit can quietly reverse.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const LAYOUT = join(process.cwd(), "src", "app", "(app)", "layout.tsx");

describe("the staff shell keeps its portal-customer guard", () => {
  const src = readFileSync(LAYOUT, "utf8");

  /* The denominator. A path typo would make every assertion below vacuous, and
     this file would sit green while guarding nothing. */
  it("actually read the staff layout", () => {
    expect(src.length, `${LAYOUT} is empty or was not found`).toBeGreaterThan(500);
    expect(src, "this is not the (app) layout any more").toContain("export default function AppLayout");
  });

  it("imports StaffAreaGuard", () => {
    expect(
      src,
      "src/app/(app)/layout.tsx no longer imports StaffAreaGuard. Without it a " +
        "signed-in portal customer sees the staff shell wrapped around an empty " +
        "page on every route in the group — see components/layout/staff-area-guard.tsx.",
    ).toContain("StaffAreaGuard");
  });

  it("renders it as the outermost element, so it covers the whole group", () => {
    /* Outermost matters: nested inside the shell it would still render the
       sidebar and top bar around the explanation, which is the confusing screen
       this replaces. The check is that the opening tag comes before the shell's
       own root div in the returned JSX. */
    const returnIdx = src.indexOf("return (");
    expect(returnIdx, "no `return (` in the layout").toBeGreaterThan(-1);
    const jsx = src.slice(returnIdx);
    const guardIdx = jsx.indexOf("<StaffAreaGuard>");
    const shellIdx = jsx.indexOf('<div className="flex min-h-screen');

    expect(guardIdx, "<StaffAreaGuard> is not rendered in the layout's JSX").toBeGreaterThan(-1);
    expect(shellIdx, "the shell's root div is not where this test expects").toBeGreaterThan(-1);
    expect(
      guardIdx,
      "<StaffAreaGuard> must wrap the shell, not sit inside it — otherwise the " +
        "sidebar and top bar render around the 'this part is for staff' message.",
    ).toBeLessThan(shellIdx);
  });
});
