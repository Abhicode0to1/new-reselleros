import { describe, it, expect } from "vitest";
import { resolveEmailProvider, canSendWithScopes, GMAIL_SEND_SCOPE, type ProviderInput } from "./provider";

const GRANTED = `openid email ${GMAIL_SEND_SCOPE}`;

const gmailReady: ProviderInput = {
  requested: "gmail",
  senderUserId: "u1",
  senderRefreshToken: "rt-123",
  senderScopes: GRANTED,
  resendConfigured: true,
};

describe("canSendWithScopes — unknown is not the same as granted", () => {
  it("accepts a scope set containing gmail.send", () => {
    expect(canSendWithScopes(GRANTED)).toBe(true);
    expect(canSendWithScopes(`${GMAIL_SEND_SCOPE} openid`)).toBe(true);
  });

  it("rejects contacts-only, which is what every existing token holds", () => {
    expect(canSendWithScopes("openid email https://www.googleapis.com/auth/contacts")).toBe(false);
  });

  it("treats NULL and blank as cannot-send rather than assuming", () => {
    // A token connected before this column existed authenticates perfectly and
    // fails only at send time, in a cron, at night. Assuming it works is how that
    // becomes a lost renewal.
    for (const s of [null, undefined, "", "   "]) {
      expect(canSendWithScopes(s as string), String(s)).toBe(false);
    }
  });

  it("does not match a scope that merely contains the string", () => {
    expect(canSendWithScopes(`${GMAIL_SEND_SCOPE}.readonly`)).toBe(false);
  });
});

describe("the default is Resend", () => {
  it("routes through Resend when nothing is set", () => {
    const d = resolveEmailProvider({ requested: null, senderUserId: null, resendConfigured: true });
    expect(d.provider).toBe("resend");
    expect(d.fellBack).toBe(false);
    expect(d.blocked).toBeNull();
  });

  it("routes through Resend when explicitly chosen", () => {
    expect(resolveEmailProvider({ requested: "resend", senderUserId: "u1", resendConfigured: true }).provider)
      .toBe("resend");
  });
});

describe("Gmail is used only when it can actually work", () => {
  it("uses Gmail when the account is connected and has granted send", () => {
    const d = resolveEmailProvider(gmailReady);
    expect(d.provider).toBe("gmail");
    expect(d.fellBack).toBe(false);
  });

  it("falls back — and SAYS WHY — for each reason it cannot", () => {
    const cases: Array<[Partial<ProviderInput>, RegExp]> = [
      [{ senderUserId: null },                          /no sending account is chosen/i],
      [{ senderRefreshToken: null },                    /not connected/i],
      [{ senderScopes: "openid email" },                /not granted permission to send/i],
      [{ senderScopes: null },                          /not granted permission to send/i],
    ];
    for (const [over, expected] of cases) {
      const d = resolveEmailProvider({ ...gmailReady, ...over });
      expect(d.provider, JSON.stringify(over)).toBe("resend");
      expect(d.fellBack).toBe(true);
      expect(d.reason).toMatch(expected);
    }
  });

  it("never silently falls back — fellBack is always set when it happens", () => {
    const d = resolveEmailProvider({ ...gmailReady, senderUserId: null });
    expect(d.fellBack).toBe(true);
    expect(d.reason.length).toBeGreaterThan(0);
  });
});

describe("the bounce caution — stated, never used to override", () => {
  it("cautions when a renewal reminder goes through Gmail", () => {
    // The failure this whole project keeps hitting: the app records "sent", the
    // customer heard nothing, and the subscription lapses.
    const d = resolveEmailProvider({ ...gmailReady, messageClass: "reminder" });
    expect(d.provider).toBe("gmail");
    expect(d.caution).toMatch(/bounces are not reported/i);
  });

  it("cautions on transactional and security too", () => {
    for (const cls of ["transactional", "security"] as const) {
      expect(resolveEmailProvider({ ...gmailReady, messageClass: cls }).caution, cls).toBeTruthy();
    }
  });

  it("does NOT caution for classes where a silent bounce costs little", () => {
    for (const cls of ["gamification", "greeting", "digest"] as const) {
      expect(resolveEmailProvider({ ...gmailReady, messageClass: cls }).caution, cls).toBeNull();
    }
  });

  it("still routes to Gmail despite the caution — it is their business", () => {
    // Overriding the tenant's explicit setting would be the easy call and the
    // wrong one. A setting that quietly does something else is worse than a
    // stated trade-off.
    expect(resolveEmailProvider({ ...gmailReady, messageClass: "reminder" }).provider).toBe("gmail");
  });

  it("carries no caution when Resend is the route, since it reports bounces", () => {
    expect(resolveEmailProvider({ requested: "resend", senderUserId: null, resendConfigured: true, messageClass: "reminder" }).caution)
      .toBeNull();
  });
});

describe("when nothing can send, say so rather than pretending", () => {
  it("blocks when Resend is unconfigured and Gmail was never selected", () => {
    const d = resolveEmailProvider({ requested: "resend", senderUserId: null, resendConfigured: false });
    expect(d.blocked).toMatch(/cannot be sent/i);
  });

  it("blocks when Gmail is unusable AND there is no Resend key to fall back to", () => {
    const d = resolveEmailProvider({ ...gmailReady, senderScopes: null, resendConfigured: false });
    expect(d.blocked).toBeTruthy();
    expect(d.blocked).toMatch(/no Resend key/i);
    expect(d.blocked).toMatch(/not granted permission to send/i);
  });

  it("does not block when Gmail works, even with no Resend key", () => {
    const d = resolveEmailProvider({ ...gmailReady, resendConfigured: false });
    expect(d.provider).toBe("gmail");
    expect(d.blocked).toBeNull();
  });

  it("always returns a reason, whatever the outcome", () => {
    for (const over of [{}, { senderUserId: null }, { resendConfigured: false }, { requested: "resend" }]) {
      expect(resolveEmailProvider({ ...gmailReady, ...over }).reason.length).toBeGreaterThan(0);
    }
  });
});
