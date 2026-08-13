import { describe, it, expect } from "vitest";
import { getCrumb, getParentListHref, getSectionPrimaryHref } from "./nav";

describe("getCrumb", () => {
  it("returns the exact crumb for a known static route", () => {
    expect(getCrumb("/customers")).toEqual(["Sales", "Customers"]);
    expect(getCrumb("/quotes/new")).toEqual(["Revenue", "Quotes", "New"]);
  });

  it("resolves dynamic detail routes via the [id] placeholder (not 'Dashboard')", () => {
    // The bug this fixes: exact lookup missed dynamic ids → everything fell back
    // to the Dashboard crumb. A real customer id is a uuid.
    expect(getCrumb("/customers/17e61b78-9450-4849-ad93-9834d2281647")).toEqual(["Sales", "Customers", "Profile"]);
    // Quote ids are prefixed text, not uuids.
    expect(getCrumb("/quotes/Q-ET-2026-27-0010")).toEqual(["Revenue", "Quotes", "Detail"]);
    expect(getCrumb("/invoices/INV-ET-2026-27-0006")).toEqual(["Revenue", "Invoices", "Detail"]);
  });

  it("resolves a mid-path id so a sub-page keeps its own crumb", () => {
    expect(getCrumb("/customers/17e61b78-9450-4849-ad93-9834d2281647/edit")).toEqual([
      "Sales",
      "Customers",
      "Edit",
    ]);
  });

  it("resolves a nested dynamic route to its known [id] parent", () => {
    expect(getCrumb("/accounting/banking/some-account-id")).toEqual(["Accounting", "Banking", "Account"]);
  });

  it("falls back to the bare section path when no [id] entry exists", () => {
    // /payments has a list crumb but no /payments/[id] entry, so a detail route
    // must still land in the right section rather than on Dashboard.
    expect(getCrumb("/payments/abc123")).toEqual(["Revenue", "Payments Received"]);
  });

  it("falls back to Dashboard for a completely unknown route", () => {
    // Must be the same crumb /dashboard itself maps to — no stale section names
    // (a shell-rendered route with no entry, e.g. /platform, lands here).
    expect(getCrumb("/totally-unknown-xyz")).toEqual(["Home", "Dashboard"]);
    expect(getCrumb("/dashboard")).toEqual(["Home", "Dashboard"]);
  });
});

describe("getParentListHref", () => {
  // The mobile Back button's target when there's no history to pop, i.e. the user
  // deep-linked into a detail page from WhatsApp/email. Must NEVER return null —
  // the previous code called getSectionPrimaryHref(pathname), which always did,
  // so router.push(null) dead-ended Back on exactly that (very common) path.
  it("returns the list page for a detail route", () => {
    expect(getParentListHref("/quotes/Q-ET-2026-27-0010")).toBe("/quotes");
    expect(getParentListHref("/invoices/INV-ET-2026-27-0006")).toBe("/invoices");
    expect(getParentListHref("/customers/17e61b78-9450-4849-ad93-9834d2281647")).toBe("/customers");
  });

  it("returns the nearest known ancestor, not the top-level segment", () => {
    expect(getParentListHref("/accounting/banking/some-account-id")).toBe("/accounting/banking");
  });

  it("skips a mid-path id to the real list page", () => {
    expect(getParentListHref("/customers/17e61b78-9450-4849-ad93-9834d2281647/edit")).toBe("/customers");
  });

  it("always returns something navigable", () => {
    expect(getParentListHref("/unknown-section/abc")).toBe("/dashboard");
    expect(getParentListHref("/platform")).toBe("/dashboard");
    expect(getParentListHref("/")).toBe("/dashboard");
  });
});

describe("getSectionPrimaryHref", () => {
  it("resolves a real APP_NAV section name to its first item", () => {
    expect(getSectionPrimaryHref("Home")).toBe("/dashboard");
    expect(getSectionPrimaryHref("Sales & CRM")).toBe("/leads");
  });

  it("returns null for anything that is not a section name", () => {
    // Guards the misuse this replaced: a pathname is never a section name.
    expect(getSectionPrimaryHref("/quotes/Q-1")).toBeNull();
    // Crumb sections are SHORT labels ("Sales"), not APP_NAV names ("Sales & CRM"),
    // so crumb[0] is not a valid argument either.
    expect(getSectionPrimaryHref("Sales")).toBeNull();
    expect(getSectionPrimaryHref("Year-End")).toBeNull();
  });
});
