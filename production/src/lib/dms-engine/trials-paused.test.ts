/** Go-live 2 Oct 2026: without DMS, free hosting trials are PAUSED (503 + message), not a 500. */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("trialsConfigured", () => {
  it("is false without the DMS engine URL or read key", async () => {
    vi.stubEnv("DMS_ENGINE_URL", "");
    vi.stubEnv("DMS_ENGINE_READ_KEY", "");
    const m = await import("./trials");
    expect(m.trialsConfigured()).toBe(false);
  });
  it("is true when both are set", async () => {
    vi.stubEnv("DMS_ENGINE_URL", "https://dms.example.test");
    vi.stubEnv("DMS_ENGINE_READ_KEY", "k");
    const m = await import("./trials");
    expect(m.trialsConfigured()).toBe(true);
  });
});

describe("wiring", () => {
  const src = (p: string) => readFileSync(join(__dirname, "../..", p), "utf8");
  it("checkout refuses a paused trial with 503 before any work, and the page hides the button", () => {
    expect(src("lib/checkout/cart-checkout.ts")).toMatch(/if \(!trialsConfigured\(\)\) \{\s*return NextResponse\.json\(\{ error: TRIALS_PAUSED_MESSAGE, trialsPaused: true \}, \{ status: 503 \}\);/);
    const page = src("app/(marketing)/checkout/page.tsx");
    expect(page).toMatch(/fetch\("\/api\/public\/trial\/hosting\/status"/);
    expect(page).toMatch(/trialsOpen === false \?/);
  });
});
