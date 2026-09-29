/**
 * sendEmail with SMTP configured (29 Sep 2026): SMTP is the platform sender ahead of
 * Resend, a tenant's Gmail choice still wins, and EMAIL_RECIPIENT_ALLOWLIST is checked
 * before ANY transport. No network: every edge is mocked, as in send.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EmailLogEntry } from "./log";
import type { EmailSendResult } from "./send";

const recorded: Array<{ entry: EmailLogEntry; result: EmailSendResult }> = [];
vi.mock("./log", () => ({
  recordEmail: vi.fn(async (entry: EmailLogEntry, result: EmailSendResult) => { recorded.push({ entry, result }); }),
}));

const sendViaGmail = vi.fn();
vi.mock("./gmail-transport", () => ({ sendViaGmail: (...a: unknown[]) => sendViaGmail(...a) }));

const sendViaSmtp = vi.fn();
vi.mock("./smtp-transport", async (orig) => {
  const real = await orig<typeof import("./smtp-transport")>();
  return { ...real, sendViaSmtp: (...a: unknown[]) => sendViaSmtp(...a) };
});

let tenantRow: Record<string, unknown> | null = null;
let tokenRow: Record<string, unknown> | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const data = table === "tenants" ? tenantRow : tokenRow;
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data, error: null }) };
      return chain;
    },
  }),
}));

const fetchSpy = vi.fn();
const TENANT = "5e7d0000-0000-4000-8000-00000000a1a1";
const msg = { to: "pawan@anutech.in", subject: "Renewal due", text: "t", route: { tenantId: TENANT, messageClass: "reminder" as const } };

let sendEmail: typeof import("./send").sendEmail;
let isEmailConfigured: typeof import("./send").isEmailConfigured;

function smtpOn() {
  vi.stubEnv("SMTP_HOST", "smtp.example.test");
  vi.stubEnv("SMTP_PORT", "587");
  vi.stubEnv("SMTP_USER", "noreply@anutech.in");
  vi.stubEnv("SMTP_PASS", "pw");
  vi.stubEnv("FROM_EMAIL", "noreply@anutech.in");
}

beforeEach(async () => {
  recorded.length = 0;
  sendViaGmail.mockReset();
  sendViaSmtp.mockReset().mockResolvedValue({ ok: true, messageId: "<m1@x>" });
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
  tenantRow = { email_provider: "resend", gmail_sender_user_id: null };
  tokenRow = null;
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("EMAIL_RECIPIENT_ALLOWLIST", "");
  for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "FROM_EMAIL"]) vi.stubEnv(k, "");
  ({ sendEmail, isEmailConfigured } = await import("./send"));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("SMTP as the platform sender", () => {
  it("with SMTP set, a non-Gmail tenant's mail goes by SMTP — not Resend — and is logged as smtp", async () => {
    smtpOn();
    const r = await sendEmail(msg);
    expect(r).toMatchObject({ status: "sent", provider: "smtp", providerId: "<m1@x>" });
    expect(sendViaSmtp).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(recorded[0].entry.provider).toBe("smtp");
  });

  it("an SMTP failure is 'failed' with the server's reason, logged as smtp, and does not fall back to Resend", async () => {
    smtpOn();
    sendViaSmtp.mockResolvedValue({ ok: false, detail: "EAUTH: 535 not accepted" });
    const r = await sendEmail(msg);
    expect(r).toMatchObject({ status: "failed", provider: "smtp", errorMessage: "SMTP: EAUTH: 535 not accepted" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a tenant on a working Gmail account still sends by Gmail", async () => {
    smtpOn();
    tenantRow = { email_provider: "gmail", gmail_sender_user_id: "u1" };
    tokenRow = { access_token: "a", refresh_token: "r", scopes: "https://www.googleapis.com/auth/gmail.send", google_email: "o@t.in" };
    sendViaGmail.mockResolvedValue({ ok: true, messageId: "g1" });
    const r = await sendEmail(msg);
    expect(r.provider).toBe("gmail");
    expect(sendViaSmtp).not.toHaveBeenCalled();
  });

  it("without SMTP the Resend path is unchanged", async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ id: "re_1" }) });
    const r = await sendEmail(msg);
    expect(r).toMatchObject({ status: "sent", provider: "resend" });
    expect(sendViaSmtp).not.toHaveBeenCalled();
  });

  it("isEmailConfigured counts SMTP on its own", () => {
    vi.stubEnv("RESEND_API_KEY", "");
    expect(isEmailConfigured()).toBe(false);
    smtpOn();
    expect(isEmailConfigured()).toBe(true);
  });
});

describe("EMAIL_RECIPIENT_ALLOWLIST runs before every transport", () => {
  it("a customer not on the list reaches NO transport, and the row says not sent", async () => {
    smtpOn();
    vi.stubEnv("EMAIL_RECIPIENT_ALLOWLIST", "@anutech.in");
    const r = await sendEmail({ ...msg, to: "owner@customer.com" });
    expect(r.status).toBe("failed");
    expect(r.errorMessage).toMatch(/not on EMAIL_RECIPIENT_ALLOWLIST/);
    expect(sendViaSmtp).not.toHaveBeenCalled();
    expect(sendViaGmail).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(recorded[0].result.status).toBe("failed");
  });

  it("also before Gmail, for a tenant on Gmail", async () => {
    vi.stubEnv("EMAIL_RECIPIENT_ALLOWLIST", "@anutech.in");
    tenantRow = { email_provider: "gmail", gmail_sender_user_id: "u1" };
    tokenRow = { access_token: "a", refresh_token: "r", scopes: "https://www.googleapis.com/auth/gmail.send", google_email: "o@t.in" };
    await sendEmail({ ...msg, to: "owner@customer.com" });
    expect(sendViaGmail).not.toHaveBeenCalled();
  });

  it("an allowed address goes through", async () => {
    smtpOn();
    vi.stubEnv("EMAIL_RECIPIENT_ALLOWLIST", "@anutech.in");
    expect((await sendEmail(msg)).status).toBe("sent");
  });
});
