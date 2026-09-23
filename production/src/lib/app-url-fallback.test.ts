/**
 * `https://resellersos.web.app` is DEAD, and it is still the fallback in 13 files.
 *
 * Measured 23 Sep 2026: that host answers **503**. L91 measured the same a month
 * earlier and said it plainly — "both paths were broken, and the 'safe default'
 * was as dead as the missing one". L91 fixed the one function it was chasing
 * (`quoteAcceptUrl`, which now returns null so each call site must decide) and
 * the PATTERN survived everywhere else:
 *
 *     const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.trim()
 *                     || "https://resellersos.web.app";
 *
 * One decision, thirteen copies, and the fix reached one — the shape AGENTS.md
 * L98 keeps recording.
 *
 * WHY THIS IS A SCAN AND NOT A FIX
 *   It is latent, not live: the Dockerfile bakes NEXT_PUBLIC_APP_URL at build
 *   time (`ARG NEXT_PUBLIC_APP_URL="https://reselleros.anutech.in"`, which
 *   answers 200), and L91 records it set on Cloud Run as well. So the fallback
 *   does not fire today. It fires the day someone builds without that arg.
 *
 *   And none of the thirteen route files has a single test. L58 is explicit
 *   about that trade: extracting shared code out of an untested money-adjacent
 *   path is the RISKY option, not the careful one. So the one site with real
 *   customer impact was fixed properly and the rest are pinned here rather than
 *   rewritten in bulk by someone who cannot prove they did it right.
 *
 * WHAT WAS FIXED
 *   `api/public/trial/hosting/confirm` redirected the CUSTOMER — the person who
 *   clicked "confirm your email" — to `${APP_URL}/hosting/trial?…`. With the
 *   env unset that is a redirect to a 503. It now builds the redirect from the
 *   request's own origin, which needs no configuration and cannot be wrong,
 *   and which also survives this service having more than one hostname (L18).
 *
 * THE LIST BELOW MAY ONLY SHRINK. A new file using this host fails here.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const DEAD_HOST = "resellersos.web.app";
const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/**
 * Files that still carry the dead host as a fallback, as of 23 Sep 2026.
 *
 * Every one of them uses it to build an INTERNAL alert link ("Open the lead:
 * …") sent to staff, which is why none was rewritten blind. Removing an entry
 * is progress; adding one is the bug this file exists to stop.
 */
const KNOWN = [
  "app/api/cron/ai-support-sla/route.ts",
  "app/api/cron/compliance-reminders/route.ts",
  "app/api/cron/provision-hosting/route.ts",
  "app/api/cron/trial-expiry/route.ts",
  "app/api/public/enquiry/general/route.ts",
  "app/api/public/enquiry/workspace/route.ts",
  "app/api/public/trial/hosting/confirm/route.ts",
  "app/api/public/trial/hosting/route.ts",
  "app/api/public/trial/workspace/route.ts",
  "app/api/v1/integrations/support-email-inbound/route.ts",
  "app/api/v1/integrations/support-whatsapp-inbound/route.ts",
  "app/api/webhooks/razorpay/route.ts",
  "lib/inbound/ingest.ts",
].sort();

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

describe("the dead fallback host does not spread", () => {
  const files = walk(SRC);

  it("the scan actually scanned the tree", () => {
    // Guard the guard: a moved directory would make the assertion below pass
    // by finding nothing at all.
    expect(files.length).toBeGreaterThan(300);
  });

  it("only the known files reference it, and the list may only shrink", () => {
    const found = files
      .filter((f) => readFileSync(f, "utf8").includes(DEAD_HOST))
      .map((f) => relative(SRC, f).split("\\").join("/"))
      .sort();

    const added = found.filter((f) => !KNOWN.includes(f));
    expect(
      added,
      `${DEAD_HOST} answers 503. Do not add it as a fallback — resolve the base URL ` +
        `from the request (new URL(path, req.url)) when you have one, or let the empty ` +
        `case be empty so the caller decides. See L91.`
    ).toEqual([]);

    // Shrinking is the point; a stale entry should be deleted from KNOWN, and
    // saying so here means the list cannot quietly rot into a permanent excuse.
    const goneButListed = KNOWN.filter((f) => !found.includes(f));
    expect(
      goneButListed,
      "these no longer use the dead host — delete them from KNOWN so the list keeps meaning something"
    ).toEqual([]);
  });

  it("the customer-facing redirect no longer depends on it", () => {
    /**
     * The one site that put the dead host in front of a CUSTOMER. Pinned by
     * behaviour rather than by absence: the file still contains the constant
     * for its internal staff alerts, so "does the string appear" cannot tell
     * whether the redirect was fixed.
     */
    const src = readFileSync(
      join(SRC, "app/api/public/trial/hosting/confirm/route.ts"),
      "utf8"
    );
    expect(src).toContain("new URL(`/hosting/trial?confirmed=${status}`, req.url)");
    expect(src).not.toMatch(/redirect\(`\$\{APP_URL\}/);
  });
});
