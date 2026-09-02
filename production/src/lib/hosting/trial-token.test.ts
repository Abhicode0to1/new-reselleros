import { describe, it, expect, beforeAll } from "vitest";
import { makeTrialToken, verifyTrialToken } from "./trial-token";

/**
 * The verification token is the trial's bot guard and the only thing standing
 * between a link and an irreversible account creation, so its failure modes are
 * pinned: a forged signature, a tampered payload and an expired link must all be
 * refused, and a genuine token must round-trip.
 */
beforeAll(() => {
  process.env.HOSTING_TRIAL_SECRET = "test-secret-abc123";
});

describe("trial token", () => {
  it("round-trips a genuine token", () => {
    const t = makeTrialToken("L-ABC", 1_000_000);
    expect(t).toBeTruthy();
    expect(verifyTrialToken(t!, 1_000_000)).toEqual({ ok: true, leadId: "L-ABC" });
  });

  it("rejects an expired link", () => {
    const t = makeTrialToken("L-ABC", 0)!;
    const r = verifyTrialToken(t, 1 + 48 * 60 * 60 * 1000);
    expect(r).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a tampered payload", () => {
    const t = makeTrialToken("L-ABC", 1_000_000)!;
    const [, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ leadId: "L-EVIL", exp: 9_999_999_999_999 }), "utf8").toString("base64url") + "." + sig;
    expect(verifyTrialToken(forged, 1_000_000).ok).toBe(false);
  });

  it("rejects a malformed token", () => {
    expect(verifyTrialToken("garbage", 1_000_000).ok).toBe(false);
    expect(verifyTrialToken("", 1_000_000).ok).toBe(false);
  });
});
