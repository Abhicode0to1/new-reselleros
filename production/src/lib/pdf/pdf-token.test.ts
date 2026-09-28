import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "crypto";
import { signPdfToken, verifyPdfToken, pdfDownloadUrl, DEFAULT_PDF_TTL_DAYS } from "./pdf-token";

/* 1 Sep 2026 (audit C6) tak ye suite KHAALI chaabi par chalti thi — module ""
   par fallback karta tha, jo har token forgeable banata. Ab bina secret ke
   sign/verify phatta hai (neeche pinned), isliye test apna secret rakhta hai.
   S20 (28 Sep 2026): token me ab exp hai, aur purane (bina exp) token grace tak chalte hain. */
const NOW = new Date("2026-09-28T10:00:00Z");
const DAY = 86_400_000;

beforeEach(() => {
  vi.stubEnv("PDF_SIGNING_SECRET", "test-secret-not-empty");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");
  vi.stubEnv("SIGNING_LEGACY_UNTIL", "");
  vi.stubEnv("PDF_TOKEN_TTL_DAYS", "");
});
afterEach(() => vi.unstubAllEnvs());

/** Purana (S20 se pehle ka) token — jaise aaj tak ke saare links me hai. */
const legacyToken = (secret: string, type: string, id: string, tenant: string) =>
  createHmac("sha256", secret).update(`${type}:${id}:${tenant}`).digest("hex");

describe("pdf-token", () => {
  const T = "t-123", I = "INV-ET-2026-27-0003";

  it("KHAALI chaabi se sign karna mana hai — dono env gayab to throw", () => {
    vi.stubEnv("PDF_SIGNING_SECRET", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(() => signPdfToken("invoice", "INV-X", "t-x")).toThrow(/No signing secret/);
  });

  it("signs deterministically for the same instant, in `<exp>.<hex>` shape", () => {
    const a = signPdfToken("invoice", I, T, { now: NOW });
    expect(a).toBe(signPdfToken("invoice", I, T, { now: NOW }));
    expect(a).toMatch(/^\d{10}\.[0-9a-f]{64}$/);
  });

  it("verifies a correct token and rejects tampering", () => {
    const tok = signPdfToken("invoice", I, T, { now: NOW });
    expect(verifyPdfToken("invoice", I, T, tok, NOW)).toBe(true);
    expect(verifyPdfToken("invoice", I, T, "", NOW)).toBe(false);
    expect(verifyPdfToken("invoice", I, T, tok.slice(0, -1) + (tok.endsWith("0") ? "1" : "0"), NOW)).toBe(false);
  });

  it("is scoped to type + id + tenant (no cross-use)", () => {
    const tok = signPdfToken("invoice", I, T, { now: NOW });
    expect(verifyPdfToken("quote", I, T, tok, NOW)).toBe(false);
    expect(verifyPdfToken("invoice", "INV-OTHER", T, tok, NOW)).toBe(false);
    expect(verifyPdfToken("invoice", I, "other-tenant", tok, NOW)).toBe(false);
  });

  it("builds a download url carrying the token", () => {
    const url = pdfDownloadUrl("https://app.example.com/", "quote", "Q-1", T, { now: NOW });
    expect(url).toBe(
      `https://app.example.com/api/v1/documents/quote/Q-1/pdf?token=${signPdfToken("quote", "Q-1", T, { now: NOW })}`,
    );
  });
});

describe("exp — link ab hamesha nahi chalta (S20)", () => {
  const T = "t-1", I = "INV-1";

  it(`default ${DEFAULT_PDF_TTL_DAYS} din: us se ek pal pehle chalta, baad me nahi`, () => {
    const tok = signPdfToken("invoice", I, T, { now: NOW });
    expect(verifyPdfToken("invoice", I, T, tok, new Date(NOW.getTime() + 29 * DAY))).toBe(true);
    expect(verifyPdfToken("invoice", I, T, tok, new Date(NOW.getTime() + 30 * DAY))).toBe(false);
  });

  it("exp badal kar umar badhana HMAC tod deta hai — ASLI JAAL", () => {
    /* exp sirf query me hota aur HMAC ke bahar, to koi bhi 9999999999 likh kar link amar kar deta. */
    const tok = signPdfToken("invoice", I, T, { now: NOW });
    const [exp, sig] = tok.split(".");
    const forged = `${Number(exp) + 365 * 86_400}.${sig}`;
    expect(verifyPdfToken("invoice", I, T, forged, NOW)).toBe(false);
  });

  it("PDF_TOKEN_TTL_DAYS aur ttlDays maante hain; 400 din se zyada clamp", () => {
    vi.stubEnv("PDF_TOKEN_TTL_DAYS", "7");
    const seven = signPdfToken("invoice", I, T, { now: NOW });
    expect(verifyPdfToken("invoice", I, T, seven, new Date(NOW.getTime() + 8 * DAY))).toBe(false);

    const huge = signPdfToken("invoice", I, T, { now: NOW, ttlDays: 100_000 });
    const exp = Number(huge.split(".")[0]);
    expect(exp).toBe(Math.floor(NOW.getTime() / 1000) + 400 * 86_400);
  });
});

describe("purane token + chaabi badalna — grace window", () => {
  const T = "t-1", I = "INV-1";
  const AFTER_GRACE = new Date("2027-01-01T00:00:00Z");

  it("purana (bina exp) token grace tak chalta hai", () => {
    const old = legacyToken("test-secret-not-empty", "invoice", I, T);
    expect(verifyPdfToken("invoice", I, T, old, NOW)).toBe(true);
  });

  it("PDF_SIGNING_SECRET set karne se PEHLE ke (service-role se sign) link nahi toot-te — ASLI JAAL", () => {
    /* Aaj tak PDF_SIGNING_SECRET set hi nahi tha → sab link service-role se sign hain. Jis din
       secret set ho, verify sirf nayi chaabi maane to DSP/email ke saare link ek saath 403. */
    const oldLegacy = legacyToken("service-role-test", "invoice", I, T);
    expect(verifyPdfToken("invoice", I, T, oldLegacy, NOW)).toBe(true);

    vi.stubEnv("PDF_SIGNING_SECRET", "");
    const signedBeforeSecret = signPdfToken("invoice", I, T, { now: NOW });
    vi.stubEnv("PDF_SIGNING_SECRET", "test-secret-not-empty");
    expect(verifyPdfToken("invoice", I, T, signedBeforeSecret, NOW)).toBe(true);
  });

  it("grace ke baad: purana format aur purani chaabi dono band", () => {
    const old = legacyToken("test-secret-not-empty", "invoice", I, T);
    expect(verifyPdfToken("invoice", I, T, old, AFTER_GRACE)).toBe(false);

    vi.stubEnv("PDF_SIGNING_SECRET", "");
    const bySvc = signPdfToken("invoice", I, T, { now: new Date("2026-12-20T00:00:00Z") });
    vi.stubEnv("PDF_SIGNING_SECRET", "test-secret-not-empty");
    expect(verifyPdfToken("invoice", I, T, bySvc, AFTER_GRACE)).toBe(false);

    /* Control: nayi chaabi ka zinda token grace ke baad bhi chalta hai. */
    const fresh = signPdfToken("invoice", I, T, { now: AFTER_GRACE });
    expect(verifyPdfToken("invoice", I, T, fresh, AFTER_GRACE)).toBe(true);
  });

  it("SIGNING_LEGACY_UNTIL se grace pehle band ki ja sakti hai; kharab date par default", () => {
    const old = legacyToken("test-secret-not-empty", "invoice", I, T);
    vi.stubEnv("SIGNING_LEGACY_UNTIL", "2026-09-01T00:00:00Z");
    expect(verifyPdfToken("invoice", I, T, old, NOW)).toBe(false);
    vi.stubEnv("SIGNING_LEGACY_UNTIL", "not-a-date");
    expect(verifyPdfToken("invoice", I, T, old, NOW)).toBe(true);
  });

  it("anjaan chaabi ka token kabhi nahi chalta", () => {
    expect(verifyPdfToken("invoice", I, T, legacyToken("attacker", "invoice", I, T), NOW)).toBe(false);
  });
});
