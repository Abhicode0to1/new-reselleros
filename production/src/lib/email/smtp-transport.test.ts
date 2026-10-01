import { describe, it, expect, vi } from "vitest";
import { smtpConfigFromEnv, sendViaSmtp, type SmtpConfig } from "./smtp-transport";

const ENV = {
  SMTP_HOST: "smtp.example.test", SMTP_PORT: "587", SMTP_SECURE: "false",
  SMTP_USER: "noreply@anutech.in", SMTP_PASS: "app-password",
  FROM_EMAIL: "noreply@anutech.in", FROM_NAME: '"Anutech Digital"',
};

describe("smtpConfigFromEnv", () => {
  it("reads a complete config, strips quotes from FROM_NAME", () => {
    expect(smtpConfigFromEnv(ENV)).toEqual({
      host: "smtp.example.test", port: 587, secure: false,
      user: "noreply@anutech.in", pass: "app-password",
      fromEmail: "noreply@anutech.in", fromName: "Anutech Digital",
    });
  });

  it("is OFF (null) when any required value is missing or the port is not a number", () => {
    for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "FROM_EMAIL"] as const) {
      expect(smtpConfigFromEnv({ ...ENV, [k]: "" }), k).toBeNull();
    }
    expect(smtpConfigFromEnv({ ...ENV, SMTP_PORT: "abc" })).toBeNull();
    expect(smtpConfigFromEnv({})).toBeNull();
  });

  it("SMTP_SECURE is true only when it says true", () => {
    expect(smtpConfigFromEnv({ ...ENV, SMTP_SECURE: "true" })?.secure).toBe(true);
    expect(smtpConfigFromEnv({ ...ENV, SMTP_SECURE: "yes" })?.secure).toBe(false);
  });
});

describe("sendViaSmtp", () => {
  const cfg = smtpConfigFromEnv(ENV) as SmtpConfig;

  it("sends FROM the configured address; the caller's From becomes Reply-To", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<abc@x>" });
    const r = await sendViaSmtp(
      { to: "pawan@anutech.in", subject: "Hi", text: "t", callerFrom: "Tenant <sales@tenant.in>" },
      cfg, { sendMail },
    );
    expect(r).toEqual({ ok: true, messageId: "<abc@x>" });
    const m = sendMail.mock.calls[0][0];
    expect(m.from).toBe('"Anutech Digital" <noreply@anutech.in>');
    expect(m.replyTo).toBe("Tenant <sales@tenant.in>");
    expect(m.to).toBe("pawan@anutech.in");
  });

  it("an explicit replyTo wins over the caller's From", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "id" });
    await sendViaSmtp({ to: "a@anutech.in", subject: "s", callerFrom: "x@t.in", replyTo: "reply@t.in" }, cfg, { sendMail });
    expect(sendMail.mock.calls[0][0].replyTo).toBe("reply@t.in");
  });

  it("a string attachment is base64, as for Resend — decoded to the real bytes", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "id" });
    await sendViaSmtp({
      to: "a@anutech.in", subject: "s",
      attachments: [{ filename: "q.pdf", content: Buffer.from("%PDF-1").toString("base64"), contentType: "application/pdf" }],
    }, cfg, { sendMail });
    const att = sendMail.mock.calls[0][0].attachments[0];
    expect(att.filename).toBe("q.pdf");
    expect(Buffer.from(att.content).toString()).toBe("%PDF-1");
  });

  it("a server refusal is a failure with the server's own words, not a throw", async () => {
    const sendMail = vi.fn().mockRejectedValue(Object.assign(new Error("Invalid login"), { code: "EAUTH", response: "535 5.7.8 Username and Password not accepted" }));
    const r = await sendViaSmtp({ to: "a@anutech.in", subject: "s" }, cfg, { sendMail });
    expect(r).toEqual({ ok: false, detail: "EAUTH: 535 5.7.8 Username and Password not accepted" });
  });
});

describe("ipv4For — connect over IPv4 (30 Sep 2026: the IPv6 attempt hung 21 s)", () => {
  it("asks the resolver for an IPv4 address only", async () => {
    const resolve = vi.fn().mockResolvedValue({ address: "192.178.158.108", family: 4 });
    const { ipv4For } = await import("./smtp-transport");
    expect(await ipv4For("smtp.gmail.com", resolve as never)).toBe("192.178.158.108");
    expect(resolve).toHaveBeenCalledWith("smtp.gmail.com", { family: 4 });
  });
  it("a failed lookup falls back to the host name (null), never throws", async () => {
    const { ipv4For } = await import("./smtp-transport");
    expect(await ipv4For("x.invalid", (async () => { throw new Error("ENOTFOUND"); }) as never)).toBeNull();
  });
  it("the transport keeps the real host name for the TLS certificate check", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/email/smtp-transport.ts", "utf8");
    expect(src).toMatch(/host: ip \?\? cfg\.host/);
    expect(src).toMatch(/tls: \{ servername: cfg\.host \}/);
  });
});
