/**
 * The ResellerOS shop is closed and DMS sells hosting.
 *
 * What these pin is not the routing trivia — it is the three ways a "closed"
 * shop quietly re-opens:
 *
 *   1. the switch defaults open (so an unset env sells),
 *   2. the money API is left reachable while only the pages are gated,
 *   3. a missing DMS url turns a redirect into a relative path that loops
 *      straight back into the app that was supposed to stop selling (L91).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resellerShopClosed,
  dmsShopOrigin,
  shopPageRedirect,
  shopApiRefused,
  shopApiRefusalMessage,
  shopPagePaths,
  refusedApiPrefixes,
} from "./reseller-shop-gate";

const ORIGINAL_SHOP = process.env.RESELLEROS_SHOP_ENABLED;
const ORIGINAL_DMS = process.env.DMS_ENGINE_URL;

function setShop(v: string | undefined) {
  if (v === undefined) delete process.env.RESELLEROS_SHOP_ENABLED;
  else process.env.RESELLEROS_SHOP_ENABLED = v;
}
function setDms(v: string | undefined) {
  if (v === undefined) delete process.env.DMS_ENGINE_URL;
  else process.env.DMS_ENGINE_URL = v;
}

beforeEach(() => {
  setShop(undefined);
  setDms("http://dms.example:4310");
});
afterEach(() => {
  setShop(ORIGINAL_SHOP);
  setDms(ORIGINAL_DMS);
});

describe("the switch fails closed", () => {
  it("is closed when the variable is unset", () => {
    // The whole point: nobody has to remember to turn selling off.
    setShop(undefined);
    expect(resellerShopClosed()).toBe(true);
  });

  it("is closed for an empty, misspelled or truthy-looking value", () => {
    // `=== "1"` rather than a truthy check, so "", "true", "yes" and "0" all
    // keep it shut. Re-opening has to be exact (L41).
    for (const v of ["", "0", "true", "yes", "on", " 1"]) {
      setShop(v);
      expect(resellerShopClosed(), `value ${JSON.stringify(v)}`).toBe(true);
    }
  });

  it("opens ONLY for an exact 1", () => {
    setShop("1");
    expect(resellerShopClosed()).toBe(false);
    expect(shopPageRedirect("/cart")).toBeNull();
    expect(shopApiRefused("/api/public/checkout/cart")).toBe(false);
  });
});

describe("shop pages redirect to DMS", () => {
  it("sends each shop page to its DMS counterpart", () => {
    expect(shopPageRedirect("/hosting")).toBe("http://dms.example:4310/hosting");
    expect(shopPageRedirect("/cart")).toBe("http://dms.example:4310/cart");
    expect(shopPageRedirect("/checkout")).toBe("http://dms.example:4310/checkout");
  });

  it("sends the trial page to DMS's hosting page, not a trial url DMS lacks", () => {
    /**
     * DMS surfaces its own 15-day trial from the plans page, gated by
     * `hosting_trial_enabled`. Redirecting to /hosting/trial there would trade
     * one dead end for another.
     */
    expect(shopPageRedirect("/hosting/trial")).toBe("http://dms.example:4310/hosting");
  });

  it("matches the trial BEFORE the plans page, not after", () => {
    // `/hosting/trial` also startsWith `/hosting`. If the order flipped, the
    // trial would still land somewhere sane here — so the real guard is that
    // the longest entry is declared first and this test would catch a reorder
    // that changed the answer.
    expect(shopPagePaths().indexOf("/hosting/trial")).toBeLessThan(
      shopPagePaths().indexOf("/hosting")
    );
  });

  it("covers sub-paths, not just the exact page", () => {
    expect(shopPageRedirect("/checkout/guest")).toBe("http://dms.example:4310/checkout");
  });

  it("leaves everything else alone", () => {
    // The gate must not become a general-purpose redirector. /domains is
    // marketing, /login and /dashboard are this app's own.
    for (const p of ["/", "/domains", "/login", "/dashboard", "/pricing", "/about"]) {
      expect(shopPageRedirect(p), p).toBeNull();
    }
  });
});

describe("the money and provisioning APIs are refused, not redirected", () => {
  it("refuses the cart checkout that creates a Razorpay order", () => {
    expect(shopApiRefused("/api/public/checkout/cart")).toBe(true);
  });

  it("refuses the trial routes that provision a real cPanel account", () => {
    expect(shopApiRefused("/api/public/trial/hosting")).toBe(true);
    expect(shopApiRefused("/api/public/trial/hosting/confirm")).toBe(true);
  });

  it("does NOT refuse the Workspace checkout — this change is hosting-only", () => {
    /**
     * Scoped deliberately (Pardeep, 24 Sep). Widening it later is a decision,
     * and this assertion is what makes the narrowing visible rather than
     * looking like an oversight.
     */
    expect(shopApiRefused("/api/public/checkout/workspace")).toBe(false);
  });

  it("never redirects an API — a POST carrying a cart cannot follow one", () => {
    for (const p of refusedApiPrefixes()) {
      expect(shopPageRedirect(p), p).toBeNull();
    }
  });

  it("the refusal says where hosting IS sold", () => {
    // §7: a block names what to do next.
    expect(shopApiRefusalMessage()).toContain("http://dms.example:4310/hosting");
    expect(shopApiRefusalMessage()).toContain("Nothing was charged");
  });
});

describe("a missing DMS url cannot become a loop back into this app", () => {
  it("returns null rather than a relative path", () => {
    /**
     * L91's rule applied here: an empty base would make the redirect target
     * "/hosting" — this app's own shop, the one being closed. The request
     * would arrive back at the gate and bounce forever, or worse, resolve to
     * the page that still sells.
     */
    setDms(undefined);
    expect(dmsShopOrigin()).toBeNull();
    expect(shopPageRedirect("/hosting")).toBeNull();
  });

  it("refuses a value with no scheme, which a browser resolves against US", () => {
    setDms("dms.example:4310");
    expect(dmsShopOrigin()).toBeNull();
  });

  it("but the APIs stay refused even with no DMS url", () => {
    /**
     * The important asymmetry. If DMS is unreachable the pages fall through to
     * this app's own shop — visible, and someone will notice. The money path
     * must NOT fall through, because a silent sale is exactly what closing the
     * shop was for.
     */
    setDms(undefined);
    expect(shopApiRefused("/api/public/checkout/cart")).toBe(true);
    expect(shopApiRefusalMessage()).toContain("This shop is closed");
  });

  it("tolerates a trailing slash on the configured url", () => {
    setDms("http://dms.example:4310///");
    expect(dmsShopOrigin()).toBe("http://dms.example:4310");
  });
});
