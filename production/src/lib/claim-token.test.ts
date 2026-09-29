import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { signClaimToken, verifyClaimToken } from "./claim-token";

/* S20 (28 Sep 2026): claim link bhi PDF_SIGNING_SECRET se sign hota hai. Employees ke paas
   pade link service-role chaabi se bane hain — secret set karte hi wo toot-te, agar verify
   sirf nayi chaabi maanta. */
beforeEach(() => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");
  vi.stubEnv("PDF_SIGNING_SECRET", "");
  vi.stubEnv("SIGNING_LEGACY_UNTIL", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("claim-token", () => {
  const T = "fbb976f1-9090-4f10-9726-0901bd144e42";

  it("sahi tenant par chalta, doosre par nahi", () => {
    const sig = signClaimToken(T);
    expect(verifyClaimToken(T, sig)).toBe(true);
    expect(verifyClaimToken("other", sig)).toBe(false);
    expect(verifyClaimToken(T, "")).toBe(false);
  });

  it("PDF_SIGNING_SECRET set hone ke baad bhi purana link chalta hai (grace) — ASLI JAAL", () => {
    const old = signClaimToken(T); // service-role se
    vi.stubEnv("PDF_SIGNING_SECRET", "new-dedicated");
    expect(verifyClaimToken(T, old)).toBe(true);
    expect(signClaimToken(T)).not.toBe(old); // naya link nayi chaabi se
    expect(verifyClaimToken(T, signClaimToken(T))).toBe(true);
  });

  it("grace khatam → purani chaabi ka link band", () => {
    const old = signClaimToken(T);
    vi.stubEnv("PDF_SIGNING_SECRET", "new-dedicated");
    vi.stubEnv("SIGNING_LEGACY_UNTIL", "2020-01-01T00:00:00Z");
    expect(verifyClaimToken(T, old)).toBe(false);
  });
});
