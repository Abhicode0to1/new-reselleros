import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ROUTES, normalizeRoutePath, stripToPath, fileForRoute } from "./route-map";

/**
 * The first block here is the one that matters: it walks `src/app` and asserts the
 * committed table matches disk. Everything else tests the matcher.
 *
 * Without it, `route-map.ts` is a hand-copied directory listing — and this repo has
 * already paid for one of those (a docs file claiming 29 migrations when there were 30,
 * and an archive README asserting every file in it had run in prod when two never had).
 * A stale route table fails quietly: triage keeps working, just with "no target file",
 * and nobody notices until the directives have been useless for a month.
 */

const APP_DIR = fileURLToPath(new URL("../../app", import.meta.url));

/** Every `page.tsx` under src/app, as { route, file } — the same shape as APP_ROUTES. */
function scanRoutes(): { route: string; file: string }[] {
  const out: { route: string; file: string }[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // The vendored Anutech marketing site (the (marketing) route group, merge
        // brick #5) is self-governed and ported incrementally — it is not part of
        // the app's screen registry (APP_ROUTES names files a bug was reported
        // from; marketing has its own site-invariants test). Skip it.
        if (entry.name === "(marketing)") continue;
        walk(full);
      } else if (entry.name === "page.tsx") {
        // Repo-relative, POSIX separators — matches how APP_ROUTES stores them.
        const file = `src/app/${relative(APP_DIR, full).split(sep).join("/")}`;
        const route =
          "/" +
          relative(APP_DIR, dir)
            .split(sep)
            .filter((s) => s && !(s.startsWith("(") && s.endsWith(")"))) // route groups
            .join("/");
        out.push({ route: route === "/" ? "/" : route.replace(/\/$/, ""), file });
      }
    }
  };

  walk(APP_DIR);
  return out.sort((a, b) => a.route.localeCompare(b.route));
}

describe("APP_ROUTES is in sync with the filesystem", () => {
  it("lists exactly the pages that exist on disk", () => {
    const onDisk = scanRoutes();
    const committed = [...APP_ROUTES].sort((a, b) => a.route.localeCompare(b.route));

    const missing = onDisk.filter((d) => !committed.some((c) => c.route === d.route));
    const extra = committed.filter((c) => !onDisk.some((d) => d.route === c.route));

    expect(
      { missing, extra },
      "src/lib/feedback/route-map.ts is out of date with src/app — add the new page(s) to APP_ROUTES (or remove the deleted ones)",
    ).toEqual({ missing: [], extra: [] });
  });

  it("points every route at the file that actually serves it", () => {
    const fileByRoute = new Map(scanRoutes().map((r) => [r.route, r.file]));
    for (const { route, file } of APP_ROUTES) {
      expect(file, `wrong file recorded for ${route}`).toBe(fileByRoute.get(route));
    }
  });

  it("stays sorted by route, so a diff on this file is readable", () => {
    const routes = APP_ROUTES.map((r) => r.route);
    expect(routes).toEqual([...routes].sort((a, b) => a.localeCompare(b)));
  });

  it("has no duplicate routes", () => {
    const routes = APP_ROUTES.map((r) => r.route);
    expect(new Set(routes).size).toBe(routes.length);
  });
});

describe("stripToPath", () => {
  it("keeps a plain path unchanged", () => {
    expect(stripToPath("/quotes/Q-ADPL-2026-27-0002")).toBe("/quotes/Q-ADPL-2026-27-0002");
  });

  it("takes the pathname out of an absolute URL", () => {
    expect(stripToPath("https://resellersos.example.com/invoices")).toBe("/invoices");
  });

  it("drops the query string, because that is where personal data hides", () => {
    // A real landing URL in this app carries ?email= and ?phone= (see lib/marketing/utm.ts).
    // A feedback row is read by the whole team; none of that belongs in it.
    expect(stripToPath("/enquiry?email=pardeep@anutech.in&phone=9876543210")).toBe("/enquiry");
  });

  it("drops the hash", () => {
    expect(stripToPath("/settings#integrations")).toBe("/settings");
  });

  it("normalises a missing leading slash", () => {
    expect(stripToPath("leads")).toBe("/leads");
  });

  it("collapses duplicate slashes and strips a trailing one", () => {
    expect(stripToPath("/quotes//new/")).toBe("/quotes/new");
  });

  it("keeps the root path as /", () => {
    expect(stripToPath("/")).toBe("/");
  });

  it("returns null for blank input", () => {
    expect(stripToPath("")).toBeNull();
    expect(stripToPath("   ")).toBeNull();
    expect(stripToPath(null)).toBeNull();
    expect(stripToPath(undefined)).toBeNull();
  });
});

describe("normalizeRoutePath", () => {
  it("collapses the real report that arrived first", () => {
    // Verbatim from support_tickets on prod, 17 Aug 2026.
    expect(normalizeRoutePath("/quotes/Q-ADPL-2026-27-0002")).toBe("/quotes/[id]");
  });

  it("leaves a static route alone", () => {
    expect(normalizeRoutePath("/attendance/me")).toBe("/attendance/me");
    expect(normalizeRoutePath("/dashboard")).toBe("/dashboard");
  });

  it("prefers a literal segment over a dynamic one", () => {
    // /quotes/new and /quotes/[id] both match "/quotes/new". Next.js serves the
    // static one; picking [id] would open the wrong file for every report from
    // the new-quote screen.
    expect(normalizeRoutePath("/quotes/new")).toBe("/quotes/new");
    expect(normalizeRoutePath("/customers/new")).toBe("/customers/new");
    expect(normalizeRoutePath("/customers/groups")).toBe("/customers/groups");
  });

  it("still resolves the dynamic sibling", () => {
    expect(normalizeRoutePath("/customers/7f3e1c22-0000-4000-8000-000000000001")).toBe("/customers/[id]");
    expect(normalizeRoutePath("/customers/groups/abc-123")).toBe("/customers/groups/[id]");
  });

  it("handles a dynamic segment that is not the last one", () => {
    expect(normalizeRoutePath("/customers/abc-123/edit")).toBe("/customers/[id]/edit");
    expect(normalizeRoutePath("/quote/abc-123/accept")).toBe("/quote/[id]/accept");
  });

  it("matches a token route", () => {
    expect(normalizeRoutePath("/quote/view/eyJhbGciOi-token")).toBe("/quote/view/[token]");
    expect(normalizeRoutePath("/assessment/some-token")).toBe("/assessment/[token]");
  });

  it("normalises a full URL with a query string", () => {
    expect(normalizeRoutePath("https://app.example.com/projects/abc-1?tab=milestones")).toBe("/projects/[id]");
  });

  it("returns null for a path no route serves, rather than guessing", () => {
    // An honest blank beats a confident wrong file. /leads/xyz has no dynamic
    // sibling — /leads is a single static page — so there is nothing to match.
    expect(normalizeRoutePath("/leads/xyz")).toBeNull();
    expect(normalizeRoutePath("/no/such/screen/at/all")).toBeNull();
  });

  it("returns null for blank input", () => {
    expect(normalizeRoutePath(null)).toBeNull();
    expect(normalizeRoutePath("")).toBeNull();
  });

  it("is idempotent — an already-normalised route survives a second pass", () => {
    for (const { route } of APP_ROUTES) {
      expect(normalizeRoutePath(route), `${route} changed on re-normalise`).toBe(route);
    }
  });
});

describe("fileForRoute", () => {
  it("resolves a known route to its page file", () => {
    expect(fileForRoute("/quotes/[id]")).toBe("src/app/(app)/quotes/[id]/page.tsx");
    expect(fileForRoute("/attendance/me")).toBe("src/app/(app)/attendance/me/page.tsx");
  });

  it("returns null for an unknown or blank route", () => {
    expect(fileForRoute("/nope")).toBeNull();
    expect(fileForRoute(null)).toBeNull();
    expect(fileForRoute("")).toBeNull();
  });
});
