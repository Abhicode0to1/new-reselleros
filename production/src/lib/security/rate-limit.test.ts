/**
 * Rate limiter ke test — ginti, khidki, aur wiring teeno.
 *
 * Wiring wala hissa isliye hai kyunki limiter ka sabse aasan failure mode
 * "bana par kahin laga nahi" hai — wahi haal money-check.yml ka tha (likha
 * gaya, kabhi chala nahi).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { rateLimit, resetRateLimiter, clientIp, publicApiLimit } from "./rate-limit";

beforeEach(() => resetRateLimiter());
afterEach(() => vi.useRealTimers());

describe("rateLimit — ginti aur khidki", () => {
  it("seema ke andar sab paas, uske baad 429-yogya", () => {
    for (let i = 0; i < 5; i++) {
      expect(rateLimit("k", { limit: 5, windowMs: 60_000 }).ok).toBe(true);
    }
    const sixth = rateLimit("k", { limit: 5, windowMs: 60_000 });
    expect(sixth.ok).toBe(false);
    expect(sixth.retryAfterSec).toBeGreaterThan(0);
  });

  it("khidki beetne par ginti nayi", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T10:00:00Z"));
    expect(rateLimit("w", { limit: 1, windowMs: 10_000 }).ok).toBe(true);
    expect(rateLimit("w", { limit: 1, windowMs: 10_000 }).ok).toBe(false);
    vi.setSystemTime(new Date("2026-09-01T10:00:11Z"));
    expect(rateLimit("w", { limit: 1, windowMs: 10_000 }).ok).toBe(true);
  });

  it("alag keys alag baltiyan", () => {
    expect(rateLimit("a", { limit: 1, windowMs: 60_000 }).ok).toBe(true);
    expect(rateLimit("b", { limit: 1, windowMs: 60_000 }).ok).toBe(true);
  });
});

describe("clientIp", () => {
  it("x-forwarded-for ki PEHLI entry client hai", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
    expect(clientIp(h)).toBe("203.0.113.9");
  });
  it("header hi na ho to 'unknown' — sab ek bounded balti me", () => {
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("publicApiLimit — kaun si raah kis seema par", () => {
  it("AI chat, likhne wale, PIN, aur GET sab par KOI na koi seema hai", () => {
    for (const p of [
      "/api/public/agent/chat",
      "/api/public/enquiry/workspace",
      "/api/public/enquiry/general",
      "/api/public/checkout/workspace",
      "/api/public/trial/workspace",
      "/api/public/expense-claim/verify",
      "/api/public/catalog/workspace",
      "/api/public/coupons/validate",
      "/api/auth/signup",
    ]) {
      expect(publicApiLimit(p), p).not.toBeNull();
    }
  });

  it("PIN-jaanch wali seema sabse kasi hui hai", () => {
    const pin = publicApiLimit("/api/public/expense-claim/verify")!;
    const chat = publicApiLimit("/api/public/agent/chat")!;
    expect(pin.limit / (pin.windowMs / 60_000)).toBeLessThan(chat.limit / (chat.windowMs / 60_000));
  });

  it("authenticated app-routes ko chhoota hai", () => {
    expect(publicApiLimit("/api/quotes/abc/send")).toBeNull();
    expect(publicApiLimit("/dashboard")).toBeNull();
  });
});

describe("wiring — limiter LAGA bhi hai", () => {
  it("middleware public raaste par rateLimit bulata hai, auth se pehle", () => {
    const src = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf8");
    const gate = src.indexOf("publicApiLimit(");
    const auth = src.indexOf("updateSession(request)");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(auth);
    expect(src).toContain("429");
  });

  it("PIN-verify route per-employee tala rakhta hai", () => {
    const src = readFileSync(
      join(process.cwd(), "src/app/api/public/expense-claim/verify/route.ts"),
      "utf8",
    );
    const gate = src.indexOf("claim-pin:");
    const rpc = src.indexOf('rpc("verify_claim_access"');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(rpc);
  });
});
