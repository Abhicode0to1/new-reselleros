/**
 * Tests for the DMS engine client.
 *
 * Two halves, and they prove different things:
 *
 *  1. FAIL-CLOSED — always runs. The module reads its config at import time, so
 *     each case re-imports with a different environment via `vi.resetModules()`.
 *     Stubbing env after the import would change nothing and the tests would
 *     pass without testing anything.
 *
 *  2. LIVE ROUND TRIP — runs only when DMS_ENGINE_URL and DMS_ENGINE_READ_KEY
 *     are set, i.e. when someone has the local Docker stack up:
 *
 *       cd Domain-Management-Project && docker compose up -d
 *       DMS_ENGINE_URL=http://localhost:4310 \
 *       DMS_ENGINE_READ_KEY=<ENGINE_READ_API_KEY from .env.docker> \
 *         npx vitest run src/lib/dms-engine/client.test.ts
 *
 *     Skipped rather than failed when unset: CI has no engine to talk to, and a
 *     suite that goes red for a missing optional dependency trains people to
 *     ignore red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const LIVE_URL = process.env.DMS_ENGINE_URL?.trim();
const LIVE_KEY = process.env.DMS_ENGINE_READ_KEY?.trim();
const hasLiveEngine = Boolean(LIVE_URL && LIVE_KEY);

/** Import the module fresh so its module-level env reads happen under the stub. */
async function freshClient() {
  vi.resetModules();
  return import("./client");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("fails closed on configuration", () => {
  beforeEach(() => {
    vi.stubEnv("DMS_ENGINE_URL", "");
    vi.stubEnv("DMS_ENGINE_READ_KEY", "");
  });

  it("reports itself unconfigured when both vars are empty", async () => {
    const { isEngineConfigured } = await freshClient();
    expect(isEngineConfigured()).toBe(false);
  });

  it("a URL without a key is NOT configured — a half-set env must not call out", async () => {
    vi.stubEnv("DMS_ENGINE_URL", "http://localhost:4310");
    const { isEngineConfigured } = await freshClient();
    expect(isEngineConfigured()).toBe(false);
  });

  it("a key without a URL is NOT configured", async () => {
    vi.stubEnv("DMS_ENGINE_READ_KEY", "some-key");
    const { isEngineConfigured } = await freshClient();
    expect(isEngineConfigured()).toBe(false);
  });

  it("makes NO network call when unconfigured — the property that matters", async () => {
    /* The risk this guards is a blank env falling back to a default host and a
       dev box quietly reading production. Asserting the reason string alone
       would not catch that; asserting fetch was never invoked does. */
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { getEngineHealth } = await freshClient();

    const result = await getEngineHealth();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("not_configured");
  });

  it("offers no panel URL when there is no configured address", async () => {
    const { dmsPanelUrl } = await freshClient();
    expect(dmsPanelUrl("admin")).toBeNull();
    expect(dmsPanelUrl("customer")).toBeNull();
  });
});

describe("never throws, whatever the engine does", () => {
  beforeEach(() => {
    vi.stubEnv("DMS_ENGINE_URL", "http://engine.test.invalid");
    vi.stubEnv("DMS_ENGINE_READ_KEY", "test-key");
  });

  it("a refused connection resolves to unreachable, not a rejection", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const { getEngineHealth } = await freshClient();

    const result = await getEngineHealth();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("unreachable");
  });

  it("a 401 is reported as unauthorized, distinct from unreachable", async () => {
    /* These two get conflated constantly, and they have opposite fixes: one is
       a wrong key, the other a wrong address. */
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 401 })
    );
    const { getEngineHealth } = await freshClient();

    const result = await getEngineHealth();
    expect(result.ok === false && result.reason).toBe("unauthorized");
  });

  it("a 500 is bad_response, and carries the status for a human", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("boom", { status: 500 })
    );
    const { getEngineHealth } = await freshClient();

    const result = await getEngineHealth();
    expect(result.ok === false && result.reason).toBe("bad_response");
    expect(result.ok === false && result.detail).toContain("500");
  });

  it("unparseable JSON resolves rather than throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not json at all", { status: 200 })
    );
    const { getEngineHealth } = await freshClient();

    await expect(getEngineHealth()).resolves.toBeDefined();
    const result = await getEngineHealth();
    expect(result.ok).toBe(false);
  });

  it("sends the key in the header the engine actually reads", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const { getEngineHealth } = await freshClient();

    await getEngineHealth();

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-integration-key"]).toBe("test-key");
  });

  it("URL-encodes the email, so a + or & cannot alter the query", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const { getEngineServices } = await freshClient();

    await getEngineServices("a+b@example.com&admin=1");

    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).not.toContain("&admin=1");
    expect(url).toContain("%26admin%3D1");
  });
});

describe.skipIf(!hasLiveEngine)("live round trip against the local engine", () => {
  it("health reports the engine and its database", async () => {
    const { getEngineHealth } = await freshClient();
    const result = await getEngineHealth();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.service).toBe("dms-engine");
      expect(result.data.database).toBe(true);
      expect(result.data.panelUrls.admin).toMatch(/\/admin$/);
    }
  });

  it("an unknown email is linked:false with empty arrays, NOT an error", async () => {
    const { getEngineServices } = await freshClient();
    const result = await getEngineServices("definitely-nobody@local.invalid");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.linked).toBe(false);
      expect(result.data.domains).toEqual([]);
      expect(result.data.hostings).toEqual([]);
    }
  });

  it("a wrong key is rejected as unauthorized, not silently accepted", async () => {
    vi.stubEnv("DMS_ENGINE_READ_KEY", "definitely-the-wrong-key");
    const { getEngineHealth } = await freshClient();

    const result = await getEngineHealth();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("unauthorized");
  });
});
