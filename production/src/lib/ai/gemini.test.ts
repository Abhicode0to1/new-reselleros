import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { geminiJson, __resetGeminiBreaker } from "./gemini";

const ARGS = { apiKey: "k".repeat(20), model: "gemini-2.5-flash", system: "s", user: "u", label: "test" };

/** Shape a successful Gemini generateContent response. */
function ok(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
    text: async () => "",
  } as unknown as Response;
}

beforeEach(() => {
  __resetGeminiBreaker();
  // Silence the route's deliberate console noise; assertions cover behaviour.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("geminiJson — an AI failure must never break the caller", () => {
  it("parses a good response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok('{"message":"hi"}')));
    await expect(geminiJson(ARGS)).resolves.toEqual({ message: "hi" });
  });

  it("strips a ```json fence the model added anyway", async () => {
    // Models still fence JSON despite responseMimeType: application/json.
    vi.stubGlobal("fetch", vi.fn(async () => ok('```json\n{"message":"hi"}\n```')));
    await expect(geminiJson(ARGS)).resolves.toEqual({ message: "hi" });
  });

  it("returns null, not a throw, on an HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 429, text: async () => "rate limited", json: async () => ({}),
    } as unknown as Response)));
    await expect(geminiJson(ARGS)).resolves.toBeNull();
  });

  it("returns null on a timeout", async () => {
    // What AbortSignal.timeout produces when the deadline passes.
    vi.stubGlobal("fetch", vi.fn(async () => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    }));
    await expect(geminiJson({ ...ARGS, timeoutMs: 10 })).resolves.toBeNull();
  });

  it("returns null on unparseable JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok("not json at all")));
    await expect(geminiJson(ARGS)).resolves.toBeNull();
  });

  it("returns null when the response has no candidates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({}), text: async () => "",
    } as unknown as Response)));
    await expect(geminiJson(ARGS)).resolves.toBeNull();
  });

  it("passes an abort signal, so a stalled Gemini cannot hang the request", async () => {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => ok('{"message":"hi"}'));
    vi.stubGlobal("fetch", spy);
    await geminiJson(ARGS);
    expect(spy.mock.calls[0][1]?.signal).toBeDefined();
  });
});

describe("circuit breaker", () => {
  it("stops calling after three consecutive failures", async () => {
    const spy = vi.fn(async () => ({
      ok: false, status: 500, text: async () => "boom", json: async () => ({}),
    } as unknown as Response));
    vi.stubGlobal("fetch", spy);

    for (let i = 0; i < 3; i++) await geminiJson(ARGS);
    expect(spy).toHaveBeenCalledTimes(3);

    // Fourth call short-circuits: when Gemini is down, the caller should not pay
    // the full timeout on every request just to reach the same stub.
    await expect(geminiJson(ARGS)).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("a success resets the failure count", async () => {
    let mode: "fail" | "pass" = "fail";
    const spy = vi.fn(async () =>
      mode === "fail"
        ? ({ ok: false, status: 500, text: async () => "", json: async () => ({}) } as unknown as Response)
        : ok('{"message":"hi"}'));
    vi.stubGlobal("fetch", spy);

    await geminiJson(ARGS);
    await geminiJson(ARGS);           // 2 failures — breaker still closed
    mode = "pass";
    await expect(geminiJson(ARGS)).resolves.toEqual({ message: "hi" });

    mode = "fail";
    await geminiJson(ARGS);
    await geminiJson(ARGS);           // only 2 since the reset
    expect(spy).toHaveBeenCalledTimes(5);   // none skipped
  });

  it("stays closed while failures are below the threshold", async () => {
    const spy = vi.fn(async () => ({
      ok: false, status: 500, text: async () => "", json: async () => ({}),
    } as unknown as Response));
    vi.stubGlobal("fetch", spy);
    await geminiJson(ARGS);
    await geminiJson(ARGS);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
