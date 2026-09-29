/**
 * S30 — the nav regroup (81 rows → 7 groups) must not lose a page or change who may open
 * it. Everything here is measured against __fixtures__/nav-before-s30.json, a snapshot of
 * the OLD nav.ts taken before the edit (base 73b52146). Never regenerate that file from
 * the current nav: the test would then compare the nav with itself and pass forever.
 *
 * Three questions, each asked per role:
 *   1. REACHABLE — can this role still click its way to every page it could click to
 *      before? (sidebar row, accordion child, or a directory row on a landing page)
 *   2. GATED THE SAME — does allowedRoutesForRole(), which middleware uses to bounce
 *      requests, give exactly the same answer? A page moved into a directory must not
 *      become a page the guard redirects.
 *   3. NOTHING GAINED — no role got a page it did not have, except the ones named below
 *      (four for owner/manager, whom middleware does not gate at all; /help for everyone, S36).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import snapshot from "./__fixtures__/nav-before-s30.json";
import {
  APP_NAV, ROLE_HOME, SCREEN_TITLES, allowedRoutesForRole, filterNavForRole, flattenNav,
  getCrumb, groupDirectory, sectionCrumb, type NavItem, type UserRole,
} from "./nav";
import { USER_ROLES } from "./auth/roles";

/**
 * Removed from the nav ON PURPOSE after S30, each with its reason. Anything else missing is
 * still a regression. The route itself still exists (it renders a notice), but for gated
 * roles the middleware now bounces it — which is the intent for a page with nothing real on it.
 *   /vendor-portal — S35, 28 Sep 2026: hardcoded demo vendor bids saved to localStorage;
 *                    replaced by a "not built yet" notice that links to Vendors / POs.
 */
const REMOVED_ON_PURPOSE = ["/vendor-portal"];
const kept = (hrefs: string[]) => hrefs.filter((h) => !REMOVED_ON_PURPOSE.includes(h));

const OLD_HREFS: string[] = kept(snapshot.hrefs);
const OLD_ALLOWED = Object.fromEntries(
  Object.entries(snapshot.allowedRoutesByRole as Record<string, string[]>).map(([r, hs]) => [r, kept(hs)]),
);
const OLD_MENU = Object.fromEntries(
  Object.entries(snapshot.menuHrefsByRole as Record<string, string[]>).map(([r, hs]) => [r, kept(hs)]),
);
const OLD_CRUMBS = snapshot.crumbs as Record<string, string[]>;

/** New in S29/S30, owner/manager only. Everything else must match the snapshot exactly. */
const ADDED_FOR_OWNER_MANAGER = ["/today", "/activity", "/purchases/inbox", "/scorecard"];
/** New in S33 (Trial Balance, Day Book) — same roles that already see P&L / Balance Sheet. */
const ADDED_FOR_BOOKS = ["/accounting/trial-balance", "/accounting/day-book"];
const BOOKS_ROLES = ["owner", "manager", "billing", "accountant"];
/** S36: Help & Tutorial opened to every role (it was owner / manager / billing / partner).
 *  Named here, not snapshotted over — the snapshot stays the pre-S30 nav. */
const ADDED_FOR_EVERY_ROLE = ["/help"];
const addedFor = (role: string) => [
  ...(role === "owner" || role === "manager" ? ADDED_FOR_OWNER_MANAGER : []),
  ...(BOOKS_ROLES.includes(role) ? ADDED_FOR_BOOKS : []),
  ...ADDED_FOR_EVERY_ROLE,
];

/** What a role can actually click: sidebar rows, their accordion children, and the
 *  directory rows on landing pages it can open. */
function clickable(role: UserRole): Set<string> {
  return new Set(flattenNav(filterNavForRole(APP_NAV, role)).map((e) => e.item.href));
}

/** Middleware's own test: pathname === a || pathname.startsWith(a + "/"). */
const permits = (allowed: string[], p: string) => allowed.some((a) => p === a || p.startsWith(a + "/"));

const APP_DIR = path.join(__dirname, "..", "app", "(app)");
/** Every page route on disk under (app), as a URL path ([param] segments kept). */
function pageRoutes(dir = APP_DIR, prefix = ""): string[] {
  const out: string[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const seg = d.name.startsWith("(") ? "" : "/" + d.name;
    const sub = path.join(dir, d.name);
    if (fs.existsSync(path.join(sub, "page.tsx"))) out.push(prefix + seg || "/");
    out.push(...pageRoutes(sub, prefix + seg));
  }
  return out;
}

describe("the snapshot is the OLD nav (guard the guard)", () => {
  it("has the 81 rows and 72 distinct hrefs the old file had", () => {
    expect(snapshot.itemCount).toBe(81);
    expect(snapshot.hrefs).toHaveLength(72);
    expect(OLD_HREFS).toHaveLength(72 - REMOVED_ON_PURPOSE.length);
    // A snapshot regenerated from the new nav would contain /today; the old one cannot.
    expect(OLD_HREFS).not.toContain("/today");
    expect(OLD_HREFS).toContain("/accounting/pnl");
  });
});

describe("1. every old href is still in the nav", () => {
  const all = new Set(flattenNav(APP_NAV).map((e) => e.item.href));
  it.each(OLD_HREFS)("%s", (href) => {
    expect(all.has(href), `${href} fell out of APP_NAV — it would be reachable only by URL`).toBe(true);
  });

  it("adds the three orphans the old nav never linked", () => {
    for (const h of ["/activity", "/purchases/inbox", "/scorecard"]) expect(all).toContain(h);
  });
});

describe.each(USER_ROLES.map((r) => [r]))("role %s", (role) => {
  const r = role as UserRole;

  it("can still click to every page it could before", () => {
    const now = clickable(r);
    const lost = OLD_MENU[r].filter((h) => !now.has(h));
    expect(lost, `${r} lost: ${lost.join(", ")}`).toEqual([]);
  });

  it("gained no page, except the named owner/manager additions", () => {
    const before = new Set([...OLD_MENU[r], ...addedFor(r)]);
    const gained = [...clickable(r)].filter((h) => !before.has(h));
    expect(gained, `${r} gained: ${gained.join(", ")}`).toEqual([]);
  });

  it("gets the same allowedRoutesForRole() as before (the middleware route guard)", () => {
    const expected = [...new Set([...OLD_ALLOWED[r], ...addedFor(r)])].sort();
    expect([...new Set(allowedRoutesForRole(r))].sort()).toEqual(expected);
  });

  it("is permitted or refused on every page route on disk exactly as before", () => {
    /* The guard is a PREFIX match, so the set test above is not the whole story: this
       asks the middleware's own question for every real route. */
    const oldAllowed = OLD_ALLOWED[r];
    const newAllowed = allowedRoutesForRole(r);
    const added = addedFor(r);
    const changed = pageRoutes().filter((p) =>
      permits(oldAllowed, p) !== permits(newAllowed, p) && !permits(added, p) && !permits(REMOVED_ON_PURPOSE, p),
    );
    expect(changed, `${r}: guard answer changed for ${changed.join(", ")}`).toEqual([]);
  });

  it("can reach its own ROLE_HOME (no login loop)", () => {
    expect(permits(allowedRoutesForRole(r), ROLE_HOME[r])).toBe(true);
  });
});

describe("2. structure", () => {
  const flat = flattenNav(APP_NAV);

  it("is the seven groups, in order", () => {
    expect(APP_NAV.map((s) => s.section)).toEqual(["Home", "Sell", "Bill", "Buy", "Books", "Team", "Settings"]);
  });

  it("has ~40 sidebar rows, none of the groups over 8", () => {
    const rows = APP_NAV.reduce((n, s) => n + s.items.length, 0);
    expect(rows).toBeGreaterThanOrEqual(35);
    expect(rows).toBeLessThanOrEqual(45);
    for (const s of APP_NAV) expect(s.items.length, s.section).toBeLessThanOrEqual(8);
  });

  it("lists every href exactly once (the old nav had 9 duplicates)", () => {
    const hrefs = flat.map((e) => e.item.href);
    const dupes = hrefs.filter((h, i) => hrefs.indexOf(h) !== i);
    expect(dupes).toEqual([]);
  });

  it("keeps ids unique across sidebar, children and directories", () => {
    const ids = flat.map((e) => e.item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts roles on every item and none on sections — so moving an item cannot change who sees it", () => {
    expect(APP_NAV.filter((s) => s.roles).map((s) => s.section)).toEqual([]);
    expect(flat.filter((e) => !e.item.roles?.length).map((e) => e.item.href)).toEqual([]);
  });

  it("never nests a row under a parent with fewer roles (it would be unreachable for the rest)", () => {
    const bad = flat
      .filter((e) => e.parent)
      .flatMap((e) => (e.item.roles ?? []).filter((r) => !(e.parent!.roles ?? []).includes(r)).map((r) => `${e.item.href} (${r}) under ${e.parent!.href}`));
    expect(bad).toEqual([]);
  });

  it("renders every directory on its landing page", () => {
    const withDir = APP_NAV.flatMap((s) => s.items).filter((i): i is NavItem & { directory: NavItem[] } => !!i.directory?.length);
    expect(withDir.map((i) => i.href).sort()).toEqual(["/marketing", "/reports"]);
    for (const i of withDir) {
      const file = path.join(APP_DIR, i.href, "page.tsx");
      const src = fs.readFileSync(file, "utf8");
      expect(src, `${i.href}/page.tsx must render <NavDirectory parentId="${i.id}" />`).toContain(`<NavDirectory parentId="${i.id}"`);
    }
  });

  it("gives every row in the tree a page that exists", () => {
    const missing = flat.map((e) => e.item.href).filter((h) => !fs.existsSync(path.join(APP_DIR, h, "page.tsx")));
    expect(missing).toEqual([]);
  });

  it("groups the Marketing Hub into five and the Reports directory by kind", () => {
    const hub = flat.find((e) => e.item.id === "marketing-hub")!.item;
    expect(groupDirectory(hub.directory!).map((g) => g.group)).toHaveLength(5);
    expect(hub.directory).toHaveLength(14);
    const reports = flat.find((e) => e.item.id === "reports")!.item;
    expect(reports.directory!.map((d) => d.href)).toEqual(expect.arrayContaining([
      "/accounting/pnl", "/accounting/balance-sheet", "/accounting/cash-flow", "/accounting/gst",
      "/accounting/tds-receivable", "/accounting/itr", "/accounting/aging", "/accounting/esi-register", "/activity",
    ]));
  });

  it("prunes children by role, not just sidebar rows", () => {
    const managerTree = flattenNav(filterNavForRole(APP_NAV, "manager")).map((e) => e.item.href);
    expect(managerTree).toContain("/vault");
    expect(managerTree).not.toContain("/vault/personal");   // owner-only child
    expect(managerTree).not.toContain("/settings/backup");  // owner-only child
    const ownerTree = flattenNav(filterNavForRole(APP_NAV, "owner")).map((e) => e.item.href);
    expect(ownerTree).toEqual(expect.arrayContaining(["/vault/personal", "/settings/backup"]));
  });
});

describe("3. breadcrumbs come from the nav", () => {
  const crumbs = new Set(APP_NAV.map(sectionCrumb));

  it("never starts a crumb with a section that does not exist (\"Engage\", \"Payroll\", …)", () => {
    const bad = Object.entries(SCREEN_TITLES).filter(([, c]) => !crumbs.has(c[0])).map(([p, c]) => `${p}: ${c.join(" › ")}`);
    expect(bad).toEqual([]);
    expect(getCrumb("/whatsapp")[0]).toBe("Home");
    expect(getCrumb("/support")[0]).toBe("Home");
  });

  it("names a sidebar/accordion row [section, label] and a directory row [section, parent, label]", () => {
    expect(getCrumb("/today")).toEqual(["Home", "Today"]);
    expect(getCrumb("/customers/groups")).toEqual(["Billing", "Parent Accounts"]);
    expect(getCrumb("/accounting/pnl")).toEqual(["Books", "Reports", "P&L Report"]);
    expect(getCrumb("/marketing/spend")).toEqual(["Sell", "Marketing Hub", "Spend"]);
  });

  it("keeps every Billing page's crumb exactly as it was (Abhishek's pages)", () => {
    for (const h of ["/customers", "/customers/groups", "/quotes", "/subscriptions", "/renewals", "/invoices", "/payments", "/projects"]) {
      expect(getCrumb(h), h).toEqual(OLD_CRUMBS[h]);
    }
    expect(getCrumb("/customers/abc/edit")).toEqual(["Billing", "Customers", "Edit"]);
    expect(getCrumb("/online-orders")).toEqual(["Billing", "Online Orders"]);
  });

  it("gives sub-pages the crumb of the page they sit under", () => {
    expect(getCrumb("/reports/profit")).toEqual(["Books", "Reports", "Profit by product/service"]);
    expect(getCrumb("/accounting/tds-receivable/year-end")).toEqual(["Books", "Reports", "TDS Receivable", "Year-End"]);
    expect(getCrumb("/deals")).toEqual(["Sell", "Sales & Pipeline", "Deal Pipeline"]);
    expect(getCrumb("/setup")).toEqual(["Settings", "Setup Wizard"]);
  });

  it("gives every old nav page a real crumb (not the Dashboard fallback)", () => {
    const fallback = OLD_HREFS.filter((h) => h !== "/dashboard" && getCrumb(h).at(-1) === "Dashboard");
    expect(fallback).toEqual([]);
  });
});
