/**
 * Playwright config — ResellerOS E2E tests.
 *
 * Layered safety net for our multi-tenant code:
 *   1. critical-path tests   — happy-path lead → quote → payment → invoice
 *   2. RLS cross-tenant tests — VERIFY tenant A cannot read tenant B's data
 *   3. role-permission tests  — owner/manager/sales scoped routes work
 *
 * Tests live in `e2e/` and assume:
 *   - A locally-running Next dev server (`npm run dev` on :3000) OR
 *     the `webServer` block below auto-starts one
 *   - Supabase with seeded test-users (run `supabase/seed/test-users.sql`)
 *
 * Run:
 *   npm run test:e2e            # headless
 *   npm run test:e2e:ui         # interactive UI mode
 *   npx playwright test --debug # step-through debugger
 *
 * CI:
 *   GitHub Actions runs this on every PR (planned in .github/workflows/ci.yml).
 *   Uses BASE_URL env from secrets pointing at staging Cloud Run URL.
 */
import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";

/**
 * Load `.env.test`.
 *
 * Every suite except the smoke tests calls `test.skip(!hasEnv, "Set … in
 * .env.test to enable.")` — 70 of 78 tests. But nothing ever read that file:
 * there was no dotenv import and no globalSetup, and dotenv is not even a
 * dependency. So the instruction printed on every skipped test was impossible
 * to follow — you could create `.env.test` exactly as told and all 70 would
 * still skip, with the same message telling you to create it.
 *
 * Read here, deliberately WITHOUT falling back to `.env.local`. That fallback
 * would be one line and would silently point a suite that creates leads and
 * records payments at the production database. Turning that on has to be a
 * decision someone makes on purpose, by creating the file.
 */
function loadEnvTest() {
  if (!fs.existsSync(".env.test")) return;
  for (const line of fs.readFileSync(".env.test", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
loadEnvTest();

// Resolve base URL from env so the same suite runs against local / staging / prod.
//
// PORT 3100, NOT 3000 — deliberately. The everyday dev server on :3000 runs with
// NEXT_PUBLIC_DEMO_MODE=true, which makes the middleware skip the auth gate
// entirely so the UI can be reviewed without logging in. That is fine for dev and
// fatal for this suite: the smoke test asserts that an unauthenticated /leads
// redirects to /login, and against a demo-mode server it cannot pass no matter
// how correct the middleware is.
//
// It did exactly that — the suite reused the running dev server (reuseExistingServer)
// and reported the auth gate as broken when the gate was fine and the environment
// was wrong. A security test that fails for an environmental reason is worse than
// no test: it teaches everyone to ignore a red e2e run.
//
// So the suite now brings up its OWN server, on its own port, with demo mode off.
// A separate port means it never collides with the dev server someone already has
// running, so no reuse is needed and no misconfigured server can be inherited.
const E2E_PORT = process.env.PLAYWRIGHT_PORT ?? "3100";
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: "./e2e",

  // ── Failure tolerance ──────────────────────────────────────
  // Retry once on CI (flaky network); zero retries locally (fail fast).
  retries: process.env.CI ? 1 : 0,
  // Fail the build if test.only is left in code.
  forbidOnly: !!process.env.CI,
  // Total timeout per test — 30s is generous; tests that need more are buggy.
  timeout: 30_000,
  // Parallel workers — defaults to half of available CPUs. CI uses 1 to
  // avoid contention with Supabase rate limits on shared test data.
  workers: process.env.CI ? 1 : undefined,

  // ── Reporting ──────────────────────────────────────────────
  // HTML report saved to playwright-report/ — view via `npx playwright show-report`.
  // List reporter to stdout for CI log readability.
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],

  // ── Shared use options ─────────────────────────────────────
  use: {
    baseURL: BASE_URL,
    // Capture artifacts on first failure to debug regressions fast.
    trace:      "retain-on-failure",
    screenshot: "only-on-failure",
    video:      "retain-on-failure",
    // Default action timeout — element interactions wait up to 10s.
    actionTimeout: 10_000,
  },

  // ── Browser projects ───────────────────────────────────────
  // Desktop Chrome covers ~95% of our Indian admin users (browser stats per
  // StatCounter India 2026). Mobile Safari covers iOS reps; Mobile Chrome
  // covers the dominant Android cohort. Add Firefox if customer complaints
  // come in — for now it's wasted CI time.
  projects: [
    {
      name: "chromium",
      use:  { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chrome",
      use:  { ...devices["Pixel 7"] },
    },
  ],

  // ── Auto-start dev server in local runs ───────────────────
  // When PLAYWRIGHT_BASE_URL points at staging/prod we skip this block.
  // Locally Playwright spins up `npm run dev` and waits for :3000 to respond.
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: `npm run dev -- -p ${E2E_PORT}`,
        url:     BASE_URL,
        // Never reuse: an inherited server may have demo mode on, which silently
        // disables the very auth gate these tests exist to verify.
        reuseExistingServer: false,
        // The auth gate must be REAL here, whatever .env.local says.
        env: { NEXT_PUBLIC_DEMO_MODE: "false" },
        timeout: 120_000,
      },
});
