/**
 * Security posture — OWASP-oriented checks that need NO seeded fixtures.
 *
 * WHY THAT CONSTRAINT SHAPES THIS FILE. 70 of the 78 tests in this suite skip
 * because they need seeded test tenants, and adding a 71st skipped test would be
 * worse than adding none: it grows the number that looks like coverage while
 * proving nothing. So every test here runs against a bare server with no session
 * and no fixtures, and every one of them asserts a protection that is supposed to
 * hold for an ANONYMOUS attacker — which is the threat model that matters most,
 * because it needs no stolen credentials.
 *
 * NOTHING HERE MUTATES DATA. Each request is either a GET, or a POST that must
 * be rejected before it reaches a write. That is deliberate: a security suite
 * that leaves rows behind cannot be run against anything real, and a suite that
 * cannot be run is not a control.
 *
 * The auth gate is genuine in this suite — playwright.config.ts starts its own
 * server with NEXT_PUBLIC_DEMO_MODE=false, because the everyday dev server
 * disables the middleware gate for UI review and would make these tests pass
 * vacuously.
 */
import { test, expect } from "@playwright/test";

/** Payloads that must never reach a query planner or a rendered page. */
const INJECTION = [
  "' OR '1'='1",
  "'; DROP TABLE leads;--",
  "1' UNION SELECT null,version()--",
  "%27%20OR%201%3D1",
  "\\'; select pg_sleep(5);--",
];

const XSS = [
  "<script>alert(1)</script>",
  '"><img src=x onerror=alert(1)>',
  "javascript:alert(document.cookie)",
  "<svg/onload=confirm(1)>",
];

/**
 * Strings that would indicate a secret or internal detail leaking out.
 *
 * `node_modules` was on this list and had to come off: it appears on every page
 * as part of Next's own dev-mode module registry
 * ("(app-pages-browser)/./node_modules/next/dist/client/components/app-router.js").
 * That is a framework artifact, not a disclosure, and keeping it here would have
 * made the suite fail for a reason unrelated to security — which is how a test
 * file stops being trusted.
 *
 * The anon Supabase key is deliberately NOT here either. It is a JWT designed to
 * ship to browsers; RLS is the boundary, not the key's secrecy. The service-role
 * key is the one that bypasses RLS, and it is what these markers hunt for.
 */
const MUST_NOT_LEAK = [
  "service_role",
  "SUPABASE_SERVICE_ROLE",
  "SERVICE_ROLE_KEY",
  "rzp_live_",
  "rzp_test_",
  "postgres://",
  "postgresql://",
  "RAZORPAY_KEY_SECRET",
  "GEMINI_API_KEY",
  "CRON_SECRET",
  "at Object.",          // a Node stack frame reaching the client
  "at async ",           // ditto
];

test.describe("transport + response headers", () => {
  test("public pages carry the hardening headers", async ({ request }) => {
    const res = await request.get("/");
    expect(res.status()).toBeLessThan(400);
    const h = res.headers();
    // These are set in next.config.mjs and are the ones that actually apply to a
    // server-rendered app: MIME sniffing, referrer leakage, device access.
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["permissions-policy"]).toContain("microphone=()");
    expect(h["permissions-policy"]).toContain("geolocation=()");
  });

  test("no response advertises the server stack", async ({ request }) => {
    const res = await request.get("/");
    const h = res.headers();
    // Knowing the exact framework version is free reconnaissance.
    expect(h["x-powered-by"]).toBeUndefined();
  });
});

test.describe("authentication gate — anonymous access", () => {
  const PROTECTED_PAGES = ["/dashboard", "/leads", "/customers", "/invoices", "/settings", "/accounting/balance-sheet", "/team"];

  for (const path of PROTECTED_PAGES) {
    test(`${path} is not served to an anonymous visitor`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    });
  }

  test("an anonymous API call gets 401, not data", async ({ request }) => {
    // /api/health/money reports which parts of the payment plumbing are off —
    // reconnaissance in itself, so it is owner-gated rather than merely quiet.
    const res = await request.get("/api/health/money");
    expect(res.status()).toBe(401);
    const body = await res.text();
    expect(body).not.toContain("razorpay");
  });

  test("a customer's invoice PDF is not downloadable without a portal session", async ({ request }) => {
    const res = await request.get("/api/portal/invoice/INV-ET-2026-27-0001/pdf");
    expect([401, 404]).toContain(res.status());
    expect(res.headers()["content-type"] ?? "").not.toContain("application/pdf");
  });
});

test.describe("JWT / bearer tampering", () => {
  const FORGED = [
    "Bearer not-a-token",
    // alg:none with an admin-ish claim — the classic unsigned-JWT attempt.
    "Bearer eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.",
    "Bearer " + "A".repeat(600),
    "Basic YWRtaW46YWRtaW4=",
  ];

  for (const auth of FORGED) {
    test(`forged credential is refused: ${auth.slice(0, 28)}…`, async ({ request }) => {
      const res = await request.get("/api/health/money", { headers: { authorization: auth } });
      expect(res.status()).toBe(401);
    });
  }

  test("the cron job refuses a wrong secret", async ({ request }) => {
    // This route suspends subscriptions and emails customers under the service
    // role, so it must fail closed. A dry run is used so that even a PASS here
    // cannot alter anything.
    const res = await request.get("/api/cron/renewals?dry=1", {
      headers: { authorization: "Bearer definitely-not-the-secret" },
    });
    expect([401, 503]).toContain(res.status());
  });
});

test.describe("webhook signature enforcement", () => {
  test("an unsigned Razorpay event is rejected", async ({ request }) => {
    // The signature is the ONLY thing standing between a real payment event and
    // a forged one — a 200 here would mean anyone can mark any quote paid.
    const res = await request.post("/api/webhooks/razorpay", {
      data: { event: "payment.captured", payload: { payment: { entity: { id: "pay_forged", amount: 100 } } } },
    });
    expect(res.status()).toBe(401);
  });

  test("a wrongly-signed Razorpay event is rejected", async ({ request }) => {
    const res = await request.post("/api/webhooks/razorpay", {
      headers: { "x-razorpay-signature": "f".repeat(64) },
      data: { event: "payment.captured", payload: {} },
    });
    expect(res.status()).toBe(401);
  });
});

test.describe("injection resilience", () => {
  for (const payload of INJECTION) {
    test(`a SQL payload in a query string neither errors nor leaks: ${payload.slice(0, 18)}…`, async ({ request }) => {
      // Public pricing page — reachable without auth, and it reads query params.
      const res = await request.get(`/pricing?q=${encodeURIComponent(payload)}`);
      // A 500 would mean the string reached something that could not handle it.
      expect(res.status()).toBeLessThan(500);

      // Scan for DATABASE-ERROR markers, with the payload itself removed first.
      // Without that removal this test fails on its own input: the "pg_sleep"
      // payload is echoed back in the page, and a naive search for "pg_" then
      // reports a leak that is only the attacker's own string coming back
      // harmlessly escaped.
      const body = (await res.text()).toLowerCase().split(payload.toLowerCase()).join(" ");
      for (const marker of ["syntax error at or near", "sqlstate", 'relation "', "pg_catalog", "duplicate key value"]) {
        expect(body, `db error marker "${marker}" surfaced`).not.toContain(marker);
      }
    });
  }

  test("a SQL payload as a record id is a clean 4xx, not a database error", async ({ request }) => {
    const res = await request.get(`/api/portal/invoice/${encodeURIComponent("' OR 1=1--")}/pdf`);
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });
});

test.describe("XSS", () => {
  for (const payload of XSS) {
    test(`a script payload is not reflected as markup: ${payload.slice(0, 20)}…`, async ({ page }) => {
      const fired: string[] = [];
      page.on("dialog", async (d) => { fired.push(d.message()); await d.dismiss(); });

      await page.goto(`/pricing?q=${encodeURIComponent(payload)}`);

      // Assert on the PARSED DOM, not on substrings of the HTML source.
      //
      // Source-substring matching gets this wrong in both directions. A payload
      // that React escaped correctly still appears verbatim in the serialised
      // HTML as text — `page.content()` re-serialises the live DOM, so escaped
      // text reads back as `onerror=alert(1)` and a naive check calls a working
      // defence a failure. What actually matters is whether the browser BUILT
      // anything from the payload.
      expect(await page.locator("img[onerror], svg[onload], body [onload]").count()).toBe(0);
      expect(await page.locator("script:not([src])", { hasText: "alert(" }).count()).toBe(0);
      expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
      // And nothing executed.
      expect(fired).toEqual([]);
    });
  }
});

test.describe("secrets and internals never appear in a response", () => {
  const PROBES = [
    "/",
    "/pricing",
    "/api/health/money",
    "/api/cron/renewals",
    "/api/webhooks/razorpay",
    "/login",
    "/nonexistent-page-should-404",
  ];

  for (const path of PROBES) {
    test(`no secret or stack frame leaks from ${path}`, async ({ request }) => {
      const res = path.startsWith("/api/webhooks") || path === "/api/cron/renewals"
        ? await request.post(path, { data: {}, failOnStatusCode: false })
        : await request.get(path, { failOnStatusCode: false });
      const body = await res.text();
      for (const secret of MUST_NOT_LEAK) {
        expect(body, `${path} leaked "${secret}"`).not.toContain(secret);
      }
    });
  }

  test("the anon Supabase key may be public, but the service key never is", async ({ request }) => {
    // The anon key is designed to ship to browsers — RLS is the boundary. The
    // service-role key bypasses RLS entirely and must never reach a client.
    const body = await (await request.get("/")).text();
    expect(body).not.toContain("service_role");
  });
});
