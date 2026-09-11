/**
 * The SMTP relay: when it is chosen, and what it does with a message.
 *
 * ─── WHY THIS TRANSPORT EXISTS AT ALL ──────────────────────────────────────
 * Measured 11 Sep 2026 with the DMS environment loaded into this app: every
 * send came back `Resend 401: API key is invalid`, so the new domain-expiry
 * warnings reached nobody. DMS has `SMTP_*` credentials and no Resend key, and
 * this app could only speak to Resend or a tenant's Gmail.
 *
 * The env names are DMS's names deliberately, so the credentials drop in with no
 * renaming — the opposite of the ResellerClub variables, where DMS's
 * `RESELLERCLUB_ID` is our `RESELLERCLUB_RESELLER_ID` and copying like-for-like
 * breaks authentication.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveEmailProvider, type ProviderInput } from "./provider";

/* ── The routing decision — pure, so no mocking ─────────────────────────── */

const base: ProviderInput = {
  requested: null,
  senderUserId: null,
  senderRefreshToken: null,
  senderScopes: null,
  resendConfigured: false,
};

describe("resolveEmailProvider — a configured relay beats no transport", () => {
  /* ─── THE CASE THIS WAS BUILT FOR ────────────────────────────────────────
     No Resend key, a working relay. Before 11 Sep 2026 this returned
     `blocked: "No email provider is configured"` and the message went nowhere,
     which is precisely the DMS deployment's situation. */
  it("uses SMTP when there is no Resend key", () => {
    const d = resolveEmailProvider({ ...base, resendConfigured: false, smtpConfigured: true });
    expect(d.provider).toBe("smtp");
    expect(d.blocked).toBeNull();
  });

  it("still blocks when there is neither", () => {
    const d = resolveEmailProvider({ ...base, resendConfigured: false, smtpConfigured: false });
    expect(d.provider).toBe("resend");
    expect(d.blocked).toMatch(/No email provider is configured/);
  });

  /* Resend reports bounces and a relay does not, so Resend stays first when
     both are available. The relay is a floor, not a preference. */
  it("prefers Resend when both are configured", () => {
    const d = resolveEmailProvider({ ...base, resendConfigured: true, smtpConfigured: true });
    expect(d.provider).toBe("resend");
  });

  it("omitting smtpConfigured means no relay — every existing caller unchanged", () => {
    const d = resolveEmailProvider({ ...base, resendConfigured: false });
    expect(d.provider).toBe("resend");
    expect(d.blocked).toBeTruthy();
  });

  it("honours a tenant that asked for SMTP, even with Resend available", () => {
    const d = resolveEmailProvider({
      ...base, requested: "smtp", resendConfigured: true, smtpConfigured: true,
    });
    expect(d.provider).toBe("smtp");
    expect(d.requested).toBe("smtp");
    expect(d.fellBack).toBe(false);
  });

  it("falls back and SAYS SO when SMTP is asked for but not configured", () => {
    const d = resolveEmailProvider({
      ...base, requested: "smtp", resendConfigured: true, smtpConfigured: false,
    });
    expect(d.provider).toBe("resend");
    /* `requested` keeps the tenant's choice — it is what an operator searches
       by when a tenant reports mail not going out. */
    expect(d.requested).toBe("smtp");
    expect(d.fellBack).toBe(true);
    expect(d.reason).toMatch(/not configured/);
  });

  it("lands on the relay when Gmail is asked for, unusable, and Resend is absent", () => {
    const d = resolveEmailProvider({
      ...base, requested: "gmail", senderUserId: null,
      resendConfigured: false, smtpConfigured: true,
    });
    expect(d.provider).toBe("smtp");
    expect(d.requested).toBe("gmail");
    expect(d.fellBack).toBe(true);
    expect(d.blocked).toBeNull();
  });
});

describe("resolveEmailProvider — the relay carries Gmail's bounce caution", () => {
  /* A `250 OK` from a relay means ACCEPTED, not delivered; the bounce arrives
     later as mail in SMTP_USER's inbox. That is the same asymmetry the whole
     provider module is built around, so SMTP must not be presented as
     equivalent to Resend. */
  it.each(["reminder", "transactional", "security"] as const)(
    "cautions on a %s message sent through the relay",
    (messageClass) => {
      const d = resolveEmailProvider({
        ...base, resendConfigured: false, smtpConfigured: true, messageClass,
      });
      expect(d.provider).toBe("smtp");
      expect(d.caution).toMatch(/bounces are not reported/);
      /* Names the transport, or the operator cannot act on it. */
      expect(d.caution).toMatch(/SMTP relay/);
    },
  );

  it("does not caution on a class where a bounce costs nothing", () => {
    const d = resolveEmailProvider({
      ...base, resendConfigured: false, smtpConfigured: true, messageClass: "gamification",
    });
    expect(d.caution).toBeNull();
  });

  it("never cautions on Resend, which does report bounces", () => {
    const d = resolveEmailProvider({
      ...base, resendConfigured: true, smtpConfigured: true, messageClass: "reminder",
    });
    expect(d.provider).toBe("resend");
    expect(d.caution).toBeNull();
  });
});

/* ── The transport itself ───────────────────────────────────────────────── */

/* Every SMTP_* the module reads. `SMTP_FROM` belongs here even though only one
   test sets it: `load()` clears this list between tests, and leaving it out let
   one test's SMTP_FROM leak into the two that followed — which failed for a
   reason that looked like the From logic being wrong rather than the fixture. */
const ENV = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_SECURE", "SMTP_FROM"] as const;
let saved: Record<string, string | undefined> = {};

type MailOptions = Record<string, unknown>;
type TransportOptions = Record<string, unknown>;

const sendMail = vi.fn<(o: MailOptions) => Promise<Record<string, unknown>>>();
const verify = vi.fn<() => Promise<boolean>>();
const createTransport = vi.fn<(o: TransportOptions) => { sendMail: typeof sendMail; verify: typeof verify }>(
  () => ({ sendMail, verify }),
);

vi.mock("nodemailer", () => ({
  default: { createTransport: (o: TransportOptions) => createTransport(o) },
  createTransport: (o: TransportOptions) => createTransport(o),
}));

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  sendMail.mockReset();
  verify.mockReset();
  createTransport.mockClear();
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.resetModules();
});

async function load(env: Partial<Record<(typeof ENV)[number], string>>) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  return import("./smtp-transport");
}

const CREDS = { SMTP_HOST: "smtp.example.test", SMTP_PORT: "587", SMTP_USER: "u@example.test", SMTP_PASS: "p" };

describe("smtpConfigured — all four, or nothing", () => {
  it("is true with host, port, user and pass", async () => {
    const { smtpConfigured } = await load(CREDS);
    expect(smtpConfigured()).toBe(true);
  });

  /* Each missing piece on its own, because a relay half-configured is the state
     an operator lands in, and "configured" must not be true for any of them —
     it is what decides whether the app claims it can send. */
  it.each(["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"] as const)(
    "is false without %s",
    async (missing) => {
      const env: Record<string, string> = { ...CREDS };
      delete env[missing];
      const { smtpConfigured } = await load(env);
      expect(smtpConfigured()).toBe(false);
    },
  );

  it("is false for a non-numeric or zero port", async () => {
    for (const SMTP_PORT of ["", "abc", "0", "-1"]) {
      const { smtpConfigured } = await load({ ...CREDS, SMTP_PORT });
      expect(smtpConfigured(), `port ${SMTP_PORT}`).toBe(false);
    }
  });
});

describe("implicit TLS vs STARTTLS", () => {
  /* Getting this backwards fails the handshake with a message about a wrong
     version number, which reads as a certificate problem and sends people the
     wrong way for an hour. */
  it("derives TLS from port 465 when SMTP_SECURE is unset", async () => {
    const { smtpDescription } = await load({ ...CREDS, SMTP_PORT: "465" });
    expect(smtpDescription()).toMatch(/\(TLS\)/);
  });

  it("derives STARTTLS from port 587 when SMTP_SECURE is unset", async () => {
    const { smtpDescription } = await load({ ...CREDS, SMTP_PORT: "587" });
    expect(smtpDescription()).toMatch(/\(STARTTLS\)/);
  });

  it.each(["true", "1", "yes", "TRUE"])("SMTP_SECURE=%s wins over the port", async (SMTP_SECURE) => {
    const { smtpDescription } = await load({ ...CREDS, SMTP_PORT: "587", SMTP_SECURE });
    expect(smtpDescription()).toMatch(/\(TLS\)/);
  });

  it.each(["false", "0", "no"])("SMTP_SECURE=%s wins over the port too", async (SMTP_SECURE) => {
    const { smtpDescription } = await load({ ...CREDS, SMTP_PORT: "465", SMTP_SECURE });
    expect(smtpDescription()).toMatch(/\(STARTTLS\)/);
  });

  it("never puts the password in the description", async () => {
    const { smtpDescription } = await load({ ...CREDS, SMTP_PASS: "s3cr3t-do-not-print" });
    expect(smtpDescription()).not.toContain("s3cr3t-do-not-print");
  });
});

describe("sendViaSmtp", () => {
  it("refuses without configuration, and sends nothing", async () => {
    const { sendViaSmtp } = await load({});
    const out = await sendViaSmtp({ to: "a@b.test", from: "c@d.test", subject: "s", text: "t" });
    expect(out.ok).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
    if (!out.ok) expect(out.retryable).toBe(false);
  });

  it("returns the Message-ID, which is what a bounce quotes back", async () => {
    const { sendViaSmtp } = await load(CREDS);
    sendMail.mockResolvedValue({ messageId: "<abc@relay>", rejected: [] });
    const out = await sendViaSmtp({ to: "a@b.test", from: "c@d.test", subject: "s", text: "t" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.messageId).toBe("<abc@relay>");
  });

  /* ─── ACCEPTED IS NOT DELIVERED ──────────────────────────────────────────
     A relay can take the envelope and refuse the recipient in the same
     response. Treating that as a success is how the app records "sent" for a
     message nobody got. */
  it("fails when the relay rejected the recipient, even on a resolved send", async () => {
    const { sendViaSmtp } = await load(CREDS);
    sendMail.mockResolvedValue({
      messageId: "<abc@relay>", rejected: ["a@b.test"], response: "550 unknown user",
    });
    const out = await sendViaSmtp({ to: "a@b.test", from: "c@d.test", subject: "s", text: "t" });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.detail).toContain("a@b.test");
      expect(out.detail).toContain("550 unknown user");
    }
  });

  /* The caller decides whether a row goes back in the queue, and it can only do
     that if these two are told apart. */
  it("calls an auth failure permanent and a timeout retryable", async () => {
    const { sendViaSmtp } = await load(CREDS);

    sendMail.mockRejectedValueOnce(new Error("Invalid login: 535 authentication failed"));
    const authFail = await sendViaSmtp({ to: "a@b.test", from: "c@d.test", subject: "s", text: "t" });
    expect(authFail.ok).toBe(false);
    if (!authFail.ok) expect(authFail.retryable).toBe(false);

    sendMail.mockRejectedValueOnce(new Error("Connection timeout"));
    const timeout = await sendViaSmtp({ to: "a@b.test", from: "c@d.test", subject: "s", text: "t" });
    expect(timeout.ok).toBe(false);
    if (!timeout.ok) expect(timeout.retryable).toBe(true);
  });

  it("builds the transporter once across many sends", async () => {
    const { sendViaSmtp } = await load(CREDS);
    sendMail.mockResolvedValue({ messageId: "<x>", rejected: [] });
    for (let i = 0; i < 4; i++) {
      await sendViaSmtp({ to: "a@b.test", from: "c@d.test", subject: "s", text: "t" });
    }
    /* One TCP connection and one TLS handshake, not four. A cron sending fifty
       warnings is the reason this is a singleton. */
    expect(createTransport).toHaveBeenCalledTimes(1);
  });

  it("sets every timeout, so one dead relay cannot stall a batch", async () => {
    const { sendViaSmtp } = await load(CREDS);
    sendMail.mockResolvedValue({ messageId: "<x>", rejected: [] });
    await sendViaSmtp({ to: "a@b.test", from: "c@d.test", subject: "s", text: "t" });
    const opts = createTransport.mock.calls[0][0];
    /* Nodemailer's own defaults are minutes. A cron cannot afford them. */
    expect(opts.connectionTimeout).toBeGreaterThan(0);
    expect(opts.greetingTimeout).toBeGreaterThan(0);
    expect(opts.socketTimeout).toBeGreaterThan(0);
  });

  it("passes reply-to and html through when given", async () => {
    const { sendViaSmtp } = await load(CREDS);
    sendMail.mockResolvedValue({ messageId: "<x>", rejected: [] });
    await sendViaSmtp({
      to: "a@b.test", from: "c@d.test", subject: "s", text: "t",
      html: "<p>t</p>", replyTo: "reply@b.test",
    });
    const sent = sendMail.mock.calls[0][0];
    expect(sent.html).toBe("<p>t</p>");
    expect(sent.replyTo).toBe("reply@b.test");
  });

  it("marks a base64 string attachment as base64, not literal text", async () => {
    const { sendViaSmtp } = await load(CREDS);
    sendMail.mockResolvedValue({ messageId: "<x>", rejected: [] });
    await sendViaSmtp({
      to: "a@b.test", from: "c@d.test", subject: "s", text: "t",
      attachments: [{ filename: "q.pdf", content: "JVBERi0=", contentType: "application/pdf" }],
    });
    const sent = sendMail.mock.calls[0][0] as { attachments: Array<Record<string, unknown>> };
    expect(sent.attachments[0].encoding).toBe("base64");
    expect(sent.attachments[0].filename).toBe("q.pdf");
  });

  it("wraps a Uint8Array attachment, which nodemailer will not take raw", async () => {
    const { sendViaSmtp } = await load(CREDS);
    sendMail.mockResolvedValue({ messageId: "<x>", rejected: [] });
    await sendViaSmtp({
      to: "a@b.test", from: "c@d.test", subject: "s", text: "t",
      attachments: [{ filename: "q.pdf", content: new Uint8Array([1, 2, 3]) }],
    });
    const sent = sendMail.mock.calls[0][0] as { attachments: Array<Record<string, unknown>> };
    expect(Buffer.isBuffer(sent.attachments[0].content)).toBe(true);
    /* A raw Uint8Array arrives as a zero-byte attachment, which looks like a
       broken PDF rather than a bug in us. */
    expect(sent.attachments[0].encoding).toBeUndefined();
  });
});

describe("the From is the relay's identity, not the caller's", () => {
  /* ─── WHY ────────────────────────────────────────────────────────────────
     A relay sends as the identity it authenticated with. The DMS credentials
     are smtp.gmail.com as noreply@anutech.in with an app password, and Gmail
     refuses or rewrites a From it has not verified for that account. Almost
     every caller here passes `onboarding@resend.dev` (the Resend sandbox
     default), so passing it through would reject every single message. */
  it("sends as SMTP_USER, ignoring the Resend sandbox default", async () => {
    const { sendViaSmtp } = await load(CREDS);
    sendMail.mockResolvedValue({ messageId: "<x>", rejected: [] });
    await sendViaSmtp({
      to: "a@b.test", from: "onboarding@resend.dev", subject: "s", text: "t",
    });
    const sent = sendMail.mock.calls[0][0];
    expect(sent.from).toBe("u@example.test");
    /* And it is NOT smuggled into Reply-To either — a sandbox address there is
       just as useless to a customer hitting reply. */
    expect(sent.replyTo).toBeUndefined();
  });

  it("prefers SMTP_FROM when the relay allows a nicer alias", async () => {
    const { sendViaSmtp } = await load({ ...CREDS, SMTP_FROM: "billing@anutech.test" });
    sendMail.mockResolvedValue({ messageId: "<x>", rejected: [] });
    await sendViaSmtp({ to: "a@b.test", from: "x@y.test", subject: "s", text: "t" });
    expect(sendMail.mock.calls[0][0].from).toBe("billing@anutech.test");
  });

  /* The caller's intent is not discarded: a real address becomes Reply-To, so a
     customer hitting reply reaches the reseller and not a no-reply box. */
  it("keeps a real caller address as Reply-To", async () => {
    const { sendViaSmtp } = await load(CREDS);
    sendMail.mockResolvedValue({ messageId: "<x>", rejected: [] });
    await sendViaSmtp({
      to: "a@b.test", from: "sales@reseller.test", subject: "s", text: "t",
    });
    const sent = sendMail.mock.calls[0][0];
    expect(sent.from).toBe("u@example.test");
    expect(sent.replyTo).toBe("sales@reseller.test");
  });

  it("never overwrites a Reply-To the caller set deliberately", async () => {
    const { sendViaSmtp } = await load(CREDS);
    sendMail.mockResolvedValue({ messageId: "<x>", rejected: [] });
    await sendViaSmtp({
      to: "a@b.test", from: "sales@reseller.test", replyTo: "support@reseller.test",
      subject: "s", text: "t",
    });
    expect(sendMail.mock.calls[0][0].replyTo).toBe("support@reseller.test");
  });

  it("does not set Reply-To to the address it is already sending as", async () => {
    const { sendViaSmtp } = await load(CREDS);
    sendMail.mockResolvedValue({ messageId: "<x>", rejected: [] });
    await sendViaSmtp({ to: "a@b.test", from: "u@example.test", subject: "s", text: "t" });
    expect(sendMail.mock.calls[0][0].replyTo).toBeUndefined();
  });
});

describe("smtpVerify — connect and authenticate, send nothing", () => {
  it("says so when nothing is configured", async () => {
    const { smtpVerify } = await load({});
    const out = await smtpVerify();
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/SMTP_HOST/);
    expect(verify).not.toHaveBeenCalled();
  });

  it("reports success without sending a message", async () => {
    const { smtpVerify } = await load(CREDS);
    verify.mockResolvedValue(true);
    const out = await smtpVerify();
    expect(out.ok).toBe(true);
    /* The whole point: credentials proven, nobody's inbox touched. */
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("passes the relay's own words back, not a generic failure", async () => {
    const { smtpVerify } = await load(CREDS);
    verify.mockRejectedValue(new Error("Invalid login: 535 Incorrect authentication data"));
    const out = await smtpVerify();
    expect(out.ok).toBe(false);
    /* "Invalid login" and "connection refused" send an operator to different
       places; a generic message sends them nowhere. */
    expect(out.detail).toMatch(/Invalid login/);
  });
});
