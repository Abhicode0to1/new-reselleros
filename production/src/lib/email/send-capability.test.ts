/**
 * `describeSendCapability` — the sentence the settings card puts at the top.
 *
 * ─── THE BUG THESE TESTS PIN ────────────────────────────────────────────────
 * The card computed this itself, one ternary per provider, and the ternary went
 * stale the moment the fallback chain grew a third link. Measured 11 Sep 2026
 * with the SMTP relay configured and no Resend key: `sendEmail` delivered the
 * message through the relay and the card said
 *
 *   "No mail is going out. Resend is selected but no API key is set, so emails
 *    are recorded as sent and silently discarded."
 *
 * Every clause false, in a red box, pointing the reader at a fix for a system
 * that was working. The same flaw sat on the Gmail branch long before the relay
 * existed: a broken Gmail grant with a good Resend key reported "No mail is
 * going out" while every message left through Resend.
 *
 * So the card no longer answers the question. It asks the router what it would
 * do and reads the verdict — one implementation of one decision.
 *
 * ─── AND THE THIRD STATE ────────────────────────────────────────────────────
 * A boolean cannot describe the case that costs money: mail IS going out, but
 * through something other than what was selected, and that something may not
 * report bounces. `usingFallback` keeps it separate from "fine" — and it is
 * deliberately BROADER than `ProviderDecision.fellBack`, which is false for
 * Resend-with-no-key even though the relay is doing the sending.
 */
import { describe, it, expect } from "vitest";
import { describeSendCapability, GMAIL_SEND_SCOPE } from "./provider";

/** A connected, send-capable Google account. */
const GOOD_GMAIL = {
  gmailSenderUserId: "11111111-1111-1111-1111-111111111111",
  gmailHasRefreshToken: true,
  gmailScopes: `openid email ${GMAIL_SEND_SCOPE}`,
};

describe("nothing configured", () => {
  it("says so, and the sentence names no transport as working", () => {
    const cap = describeSendCapability({
      provider: "resend",
      resendConfigured: false,
      smtpConfigured: false,
    });
    expect(cap.canSend).toBe(false);
    expect(cap.usingFallback).toBe(false);
    expect(cap.blocked).toBeTruthy();
    /* The card prints `blocked` verbatim, so it has to be a sentence a person
       can act on rather than a code. */
    expect(cap.blocked).toMatch(/no email provider is configured/i);
  });

  /* "Not sending" and "sending through something else" must never appear
     together. Reading `ProviderDecision.fellBack` straight through would do
     exactly that: the tenant asked for Gmail, it was unusable, and nothing
     else could send either. */
  it("never reports a fallback while blocked", () => {
    const cap = describeSendCapability({
      provider: "gmail",
      gmailSenderUserId: null,
      resendConfigured: false,
      smtpConfigured: false,
    });
    expect(cap.canSend).toBe(false);
    expect(cap.usingFallback).toBe(false);
  });
});

describe("Resend", () => {
  it("is fine when a key is present", () => {
    const cap = describeSendCapability({
      provider: "resend",
      resendConfigured: true,
      smtpConfigured: false,
    });
    expect(cap).toMatchObject({ canSend: true, via: "resend", usingFallback: false, blocked: null });
  });

  /* ─── THE FALSE ALARM THIS FILE EXISTS FOR ─────────────────────────────────
     Resend selected, no key, relay configured. The old card said "No mail is
     going out … recorded as sent and silently discarded" while every message
     was being delivered. */
  it("reports SENDING via the relay when it has no key and a relay exists", () => {
    const cap = describeSendCapability({
      provider: "resend",
      resendConfigured: false,
      smtpConfigured: true,
    });
    expect(cap.canSend).toBe(true);
    expect(cap.blocked).toBeNull();
    expect(cap.via).toBe("smtp");
  });

  /* And it is NOT reported as fine. `ProviderDecision.fellBack` is false here —
     Resend is the default, nobody "asked" for it — which is precisely why this
     compares `via` against what is selected instead of copying that flag. A
     green badge here tells a reseller bounces are being reported when they are
     not. */
  it("flags that as a fallback even though the decision does not call it one", () => {
    const cap = describeSendCapability({
      provider: "resend",
      resendConfigured: false,
      smtpConfigured: true,
    });
    expect(cap.usingFallback).toBe(true);
  });

  /* The banner prints `reason`, and it used to read "Tenant sends through
     Resend." on a message the relay carried. That string is also recorded
     against the send, so a wrong one answers "which transport carried this?"
     wrongly, weeks later, when the bounce is being chased. */
  it("gives a reason that does not claim Resend carried it", () => {
    const cap = describeSendCapability({
      provider: "resend",
      resendConfigured: false,
      smtpConfigured: true,
    });
    /* The old string was "Tenant sends through Resend." on a message the relay
       carried. It is recorded against the send, so it answers "which transport
       carried this?" — and it answered wrongly. */
    expect(cap.reason).not.toMatch(/sends through Resend/i);
    expect(cap.reason).toMatch(/no Resend key/i);
    /* It states the CAUSE, not the route: `via` already carries the route, and
       a reason that repeats it renders as "going out through the SMTP relay …
       so this went through the SMTP relay instead." Measured in the browser. */
    expect(cap.reason).not.toMatch(/SMTP relay/i);
  });

  it("prefers Resend over the relay when both are configured", () => {
    const cap = describeSendCapability({
      provider: "resend",
      resendConfigured: true,
      smtpConfigured: true,
    });
    expect(cap.via).toBe("resend");
    expect(cap.usingFallback).toBe(false);
  });
});

describe("the SMTP relay, selected on purpose", () => {
  it("sends, and is not called a fallback", () => {
    const cap = describeSendCapability({
      provider: "smtp",
      resendConfigured: false,
      smtpConfigured: true,
    });
    expect(cap).toMatchObject({ canSend: true, via: "smtp", usingFallback: false, blocked: null });
  });

  /* Selected while the server has no relay. Reachable in practice: the tenant
     row is stored, then the env changes under it — a deploy without SMTP_PASS,
     or a rotation nobody finished. The switch refuses this at selection time;
     this is the state it can still drift into afterwards. */
  it("falls to Resend when the env lost the relay, and says so", () => {
    const cap = describeSendCapability({
      provider: "smtp",
      resendConfigured: true,
      smtpConfigured: false,
    });
    expect(cap.canSend).toBe(true);
    expect(cap.via).toBe("resend");
    expect(cap.usingFallback).toBe(true);
    expect(cap.reason).toMatch(/not configured/i);
  });

  it("is blocked when the relay is gone and there is no Resend key", () => {
    const cap = describeSendCapability({
      provider: "smtp",
      resendConfigured: false,
      smtpConfigured: false,
    });
    expect(cap.canSend).toBe(false);
    expect(cap.blocked).toMatch(/SMTP/i);
  });
});

describe("Gmail", () => {
  it("sends when the account is connected and granted the send scope", () => {
    const cap = describeSendCapability({
      provider: "gmail",
      ...GOOD_GMAIL,
      resendConfigured: true,
      smtpConfigured: false,
    });
    expect(cap).toMatchObject({ canSend: true, via: "gmail", usingFallback: false });
  });

  /* The pre-existing false alarm, fixed by the same mechanism: mail was leaving
     through Resend and the card said none was. */
  it("reports SENDING via Resend when the grant is broken", () => {
    const cap = describeSendCapability({
      provider: "gmail",
      ...GOOD_GMAIL,
      gmailScopes: "openid email",  // connected, never allowed to send
      resendConfigured: true,
      smtpConfigured: false,
    });
    expect(cap.canSend).toBe(true);
    expect(cap.via).toBe("resend");
    expect(cap.usingFallback).toBe(true);
    /* Which step is missing — the whole reason the route hands the scope string
       to this function instead of a single canSend boolean. "Not connected" and
       "connected but not allowed to send" send an operator to different
       places. */
    expect(cap.reason).toMatch(/permission to send/i);
  });

  it("distinguishes a missing token from a missing scope", () => {
    const noToken = describeSendCapability({
      provider: "gmail",
      ...GOOD_GMAIL,
      gmailHasRefreshToken: false,
      resendConfigured: true,
      smtpConfigured: false,
    });
    expect(noToken.reason).toMatch(/not connected/i);
    expect(noToken.reason).not.toMatch(/permission to send/i);
  });

  /* The sender is read from the STORED column, never from whoever is looking at
     the page. `loadContext` falls back to the caller for the connection panel,
     which is right there and wrong here — "no sending account has been chosen"
     is a real blocker with its own next step. */
  it("names the missing sender when none was ever designated", () => {
    const cap = describeSendCapability({
      provider: "gmail",
      gmailSenderUserId: null,
      gmailHasRefreshToken: true,
      gmailScopes: GMAIL_SEND_SCOPE,
      resendConfigured: true,
      smtpConfigured: false,
    });
    expect(cap.via).toBe("resend");
    expect(cap.reason).toMatch(/no sending account is chosen/i);
  });

  it("falls all the way to the relay when Gmail is broken and Resend has no key", () => {
    const cap = describeSendCapability({
      provider: "gmail",
      ...GOOD_GMAIL,
      gmailScopes: null,
      resendConfigured: false,
      smtpConfigured: true,
    });
    expect(cap.canSend).toBe(true);
    expect(cap.via).toBe("smtp");
    expect(cap.usingFallback).toBe(true);
  });
});

describe("an unknown provider string", () => {
  /* `tenants.email_provider` is NOT NULL with a default of 'resend', and a
     CHECK constraint bounds it — but this function also answers for rows read
     before a migration widens that list, and for null from a tenant row that
     did not load. Treating an unrecognised value as Resend keeps the screen
     truthful instead of throwing on a settings page. */
  it("treats null as Resend rather than failing", () => {
    const cap = describeSendCapability({
      provider: null,
      resendConfigured: true,
      smtpConfigured: false,
    });
    expect(cap).toMatchObject({ canSend: true, via: "resend", usingFallback: false });
  });

  it("is case-insensitive about the stored value", () => {
    const cap = describeSendCapability({
      provider: "SMTP",
      resendConfigured: false,
      smtpConfigured: true,
    });
    expect(cap.via).toBe("smtp");
    expect(cap.usingFallback).toBe(false);
  });
});
