/**
 * Rate limiter ke test — ginti, khidki, aur wiring teeno.
 *
 * Wiring wala hissa isliye hai kyunki limiter ka sabse aasan failure mode
 * "bana par kahin laga nahi" hai — wahi haal money-check.yml ka tha (likha
 * gaya, kabhi chala nahi).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { readFileSync, readdirSync } from "fs";
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

/**
 * Ye block pehle ULTA daawa karta tha — "x-forwarded-for ki PEHLI entry client
 * hai" — aur isi liye bug pakda nahi gaya: test khud usi galti ko sach maan
 * kar baitha tha. Google ke dastavez: infra maujooda header me APPEND karta
 * hai aur usse pehle ki entries verify NAHI karta, to `[0]` bhejne wale ka
 * likha hua hai.
 */
describe("clientIp — daaye se, kyunki baaya sira client ka likha hai", () => {
  it("seedha Cloud Run: ek hi entry, wahi client", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  /* ASLI HAMLA: client apna XFF bhejta hai, infra uske BAAD asli IP jodta hai. */
  it("client ka bheja hua IP nahi maanta — infra ka joda hua maanta hai", () => {
    const spoofed = new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" });
    expect(clientIp(spoofed)).toBe("203.0.113.9");
    expect(clientIp(spoofed)).not.toBe("1.2.3.4");
  });

  it("chahe kitni bhi nakli entries aage jod de", () => {
    const h = new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.9" });
    expect(clientIp(h)).toBe("203.0.113.9");
  });

  it("khaali aur bekaar entries gir jaati hain", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": " , , 203.0.113.9 " }))).toBe("203.0.113.9");
  });

  it("header hi na ho to 'unknown' — sab ek bounded balti me", () => {
    expect(clientIp(new Headers())).toBe("unknown");
  });

  it("XFF na ho to x-real-ip", () => {
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.7" }))).toBe("198.51.100.7");
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

/**
 * Ek hi jagah se IP padha jaye.
 *
 * 12 Sep 2026 ko is app me SAAT jagah `x-forwarded-for.split(",")[0]` likha
 * tha — rate limit, attendance ka office-IP darwaza, vault ke audit log, quote
 * acceptance ka signer_ip. Har ek wahi lautata tha jo BHEJNE WALE ne header me
 * likha, kyunki infra maujooda header me append karta hai, replace nahi.
 *
 * Ye galti copy-paste se failti hai, isliye test source padhta hai: naya
 * reader banega to yahin girega, kisi ke office-network gate par nahi.
 */
describe("x-forwarded-for sirf ek hi jagah padha jaye", () => {
  const ROOT = join(process.cwd(), "src");

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(e.name) && !e.name.includes(".test.")) out.push(full);
    }
    return out;
  }

  const files = walk(ROOT);

  it("denominator — source files mile", () => {
    expect(files.length, "src me koi file nahi mili").toBeGreaterThan(200);
  });

  it("sirf lib/security/rate-limit.ts header ko chhuta hai", () => {
    const readers = files
      .filter((f) => /get\(\s*["']x-forwarded-for["']\s*\)/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1).split("\\").join("/"));
    expect(
      readers,
      "har naya reader apna `[0]` le aata hai, jo bhejne wale ka likha hua hai.\n" +
        "clientIp() ya clientIpOrNull() import karo — unke apne test hain.",
    ).toEqual(["lib/security/rate-limit.ts"]);
  });
});
