/**
 * No hidden pages (Pardeep, 3 Oct 2026: "koi bhi hidden link nahi rahna chahiye").
 * Every app page is a menu row (APP_NAV, including accordion children and directories) or
 * is in NOT_IN_NAV with a written reason. A new page that is neither fails here.
 */
import { describe, it, expect } from "vitest";
import { APP_NAV, NOT_IN_NAV, flattenNav } from "./nav";
import { APP_ROUTES } from "./feedback/route-map";

describe("every app page can be found from the menu", () => {
  const inNav = new Set(flattenNav(APP_NAV).map(({ item }) => item.href.split("?")[0]));
  const appPages = APP_ROUTES.filter((r) => r.file.includes("/(app)/") && !r.route.includes("["));

  it("each page is in the menu or has a reason not to be", () => {
    const hidden = appPages.map((r) => r.route).filter((r) => !inNav.has(r) && !(r in NOT_IN_NAV));
    expect(hidden, "add these to APP_NAV (lib/nav.ts) — or to NOT_IN_NAV with the reason").toEqual([]);
  });

  it("the not-in-menu list has no stale entries and every reason says something", () => {
    const pages = new Set(appPages.map((r) => r.route));
    for (const [route, why] of Object.entries(NOT_IN_NAV)) {
      expect(pages.has(route), `${route} is no longer a page — remove it from NOT_IN_NAV`).toBe(true);
      expect(inNav.has(route), `${route} is in the menu now — remove it from NOT_IN_NAV`).toBe(false);
      expect(why.length).toBeGreaterThan(15);
    }
  });
});
