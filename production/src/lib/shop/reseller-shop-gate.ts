/**
 * The ResellerOS shop is CLOSED. DMS is the hosting shop.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * Both apps could sell hosting, and for a while only ResellerOS's funnel was
 * reachable — not by decision, but because DMS's `/hosting` was left `draft` in
 * its own page_visibility settings on 21 Jul 2026. Measured 24 Sep 2026: a buyer
 * on DMS `/hosting` was bounced to ResellerOS's marketing home, so every hosting
 * sale went through ResellerOS.
 *
 * Pardeep's call, 24 Sep 2026: **DMS is the valid shop.** DMS's page is
 * published and ResellerOS's shop is switched off here.
 *
 * ─── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
 * It does not touch a single line of the shop itself. `(marketing)/hosting`,
 * `(marketing)/cart`, `(marketing)/checkout`, `(marketing)/hosting/trial` and
 * `api/public/checkout/cart` are all left exactly as they are, by instruction —
 * that code is not to be modified until Pardeep says so explicitly. This is a
 * gate in front of them, so re-opening the shop is a config change and not an
 * archaeology exercise.
 *
 * ─── REDIRECT, NOT 404 ──────────────────────────────────────────────────────
 * A buyer arriving from a bookmark, an old email or a search result is sent to
 * the DMS page that does the same job, so no sale dead-ends (AGENTS.md §7: a
 * block must say what to do next, and a redirect that lands somewhere useful
 * says it best). The APIs are refused outright rather than redirected, because
 * a POST carrying a cart cannot be meaningfully forwarded and must not be
 * allowed to create a Razorpay order from an app that no longer sells.
 *
 * ─── FAIL CLOSED ────────────────────────────────────────────────────────────
 * `RESELLEROS_SHOP_ENABLED !== "1"` keeps it shut, so an empty or misspelled
 * value leaves the shop closed rather than open — the same posture as the /dev
 * gate (L41). Re-opening is deliberate and greppable.
 */

/** True when the ResellerOS shop is switched off (the default). */
export function resellerShopClosed(): boolean {
  return process.env.RESELLEROS_SHOP_ENABLED !== "1";
}

/**
 * Customer-facing shop pages, mapped to the DMS page that replaces each.
 *
 * `/hosting/trial` maps to DMS's `/hosting` rather than a trial-specific page
 * because DMS surfaces its own 15-day trial from the plans page itself, gated
 * by the `hosting_trial_enabled` setting. Sending someone to a trial URL that
 * does not exist on DMS would trade one dead end for another.
 *
 * Longest match wins, so `/hosting/trial` is decided before `/hosting`.
 */
const SHOP_PAGES: ReadonlyArray<readonly [string, string]> = [
  ["/hosting/trial", "/hosting"],
  ["/hosting", "/hosting"],
  ["/cart", "/cart"],
  ["/checkout", "/checkout"],
];

/**
 * Paths that must be REFUSED, not forwarded.
 *
 * `checkout/cart` creates a real Razorpay order. The trial routes provision a
 * real cPanel account and email credentials. Neither may run from an app that
 * no longer sells — and unlike a page, a caller of these is a script or a
 * fetch, which cannot follow a redirect to a different app's UI meaningfully.
 *
 * `api/public/checkout/workspace` is deliberately NOT here: Pardeep scoped this
 * to hosting, and nothing on the site currently drives traffic to it.
 */
const REFUSED_API_PREFIXES: readonly string[] = [
  "/api/public/checkout/cart",
  "/api/public/trial/hosting",
];

/** The DMS origin, or null when it is not configured. */
export function dmsShopOrigin(): string | null {
  /**
   * Derived from DMS_ENGINE_URL on purpose, following `dmsPanelUrl()`'s reason
   * for doing the same: a second env var can drift, and the failure mode is a
   * local ResellerOS sending a customer to production DMS. One source, or none.
   *
   * Returns null rather than "" so a missing value cannot become a relative
   * redirect that silently loops back into this app (L91).
   */
  const raw = (process.env.DMS_ENGINE_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw || !/^https?:\/\//i.test(raw)) return null;
  return raw;
}

/**
 * Where a shop page request should be sent, or null if this path is not a shop
 * page. Query and hash are preserved by the caller, not here.
 */
export function shopPageRedirect(pathname: string): string | null {
  if (!resellerShopClosed()) return null;
  const origin = dmsShopOrigin();
  if (!origin) return null;

  for (const [from, to] of SHOP_PAGES) {
    if (pathname === from || pathname.startsWith(from + "/")) {
      return origin + to;
    }
  }
  return null;
}

/** True when this path is a shop API that must be refused outright. */
export function shopApiRefused(pathname: string): boolean {
  if (!resellerShopClosed()) return false;
  return REFUSED_API_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/**
 * What to tell a caller of a refused API.
 *
 * Names the app that does sell, so an integrator reading a 410 in a log knows
 * where to go rather than filing a bug against a working system (§7).
 */
export function shopApiRefusalMessage(): string {
  const origin = dmsShopOrigin();
  return (
    "This shop is closed. Hosting is sold by the hosting panel" +
    (origin ? ` at ${origin}/hosting` : "") +
    ". Nothing was charged and no account was created."
  );
}

/** Exported for tests and tooling. */
export function shopPagePaths(): string[] {
  return SHOP_PAGES.map(([from]) => from);
}
export function refusedApiPrefixes(): string[] {
  return [...REFUSED_API_PREFIXES];
}
