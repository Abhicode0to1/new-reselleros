import { describe, it, expect, afterEach, vi } from "vitest";
import { verifyTurnstile, readTurnstileToken, turnstileEnabled, TURNSTILE_VERIFY_URL } from "./turnstile";

/* S20 (28 Sep 2026). Sabse zaroori baat pehla test hai: bina key ke ye kuch nahi rokta —
   warna UI me widget lagne se pehle hi har enquiry/signup 403 khata. */
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const cf = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("verifyTurnstile", () => {
  it("TURNSTILE_SECRET_KEY nahi → no-op, network ko chhoota bhi nahi — ASLI JAAL", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    const f = cf({ success: false });
    expect(turnstileEnabled()).toBe(false);
    expect(await verifyTurnstile(null, "1.2.3.4", f)).toEqual({ ok: true, skipped: true });
    expect(f).not.toHaveBeenCalled();
  });

  it("key set + token nahi → mana", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "sk-test");
    const f = cf({ success: true });
    const r = await verifyTurnstile("", null, f);
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("Cloudflare success:true → paas; secret, token, IP form me jaate hain", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "sk-test");
    const f = cf({ success: true });
    expect(await verifyTurnstile("tok-1", "203.0.113.9", f)).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TURNSTILE_VERIFY_URL);
    const form = new URLSearchParams(String(init.body));
    expect(form.get("secret")).toBe("sk-test");
    expect(form.get("response")).toBe("tok-1");
    expect(form.get("remoteip")).toBe("203.0.113.9");
  });

  it("Cloudflare success:false → BAND, wajah ke saath", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "sk-test");
    const r = await verifyTurnstile("tok-bad", null, cf({ success: false, "error-codes": ["invalid-input-response"] }));
    expect(r).toEqual({ ok: false, reason: "invalid-input-response" });
  });

  it("Cloudflare 5xx / network down → khula (fail-open), skipped mark ke saath", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "sk-test");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await verifyTurnstile("tok", null, cf({}, 503))).toMatchObject({ ok: true, skipped: true });
    const down = vi.fn(async () => { throw new Error("ENOTFOUND"); });
    expect(await verifyTurnstile("tok", null, down)).toMatchObject({ ok: true, skipped: true });
  });

  it("'unknown' IP Cloudflare ko nahi bhejta", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "sk-test");
    const f = cf({ success: true });
    await verifyTurnstile("tok", "unknown", f);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URLSearchParams(String(init.body)).has("remoteip")).toBe(false);
  });
});

describe("readTurnstileToken", () => {
  it("header pehle, phir body ke dono naam", () => {
    expect(readTurnstileToken(new Headers({ "x-turnstile-token": "h" }), { turnstileToken: "b" })).toBe("h");
    expect(readTurnstileToken(new Headers(), { "cf-turnstile-response": "w" })).toBe("w");
    expect(readTurnstileToken(new Headers(), { turnstileToken: "b" })).toBe("b");
    expect(readTurnstileToken(new Headers(), { other: 1 })).toBeNull();
    expect(readTurnstileToken(new Headers())).toBeNull();
  });
});
