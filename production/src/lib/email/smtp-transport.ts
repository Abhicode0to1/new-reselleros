/**
 * SMTP — the platform sender when SMTP_* is set (owner, 29 Sep 2026: "use these for
 * sending any type of email"), ahead of Resend.
 *
 * It sits where Resend sat: the transport a message takes when the tenant has not chosen
 * Gmail (or its Gmail cannot be used). Everything around it is unchanged — the kill switch
 * and autonomy dial in sendEmail, the email_log row, the recipient allow-list.
 *
 * FROM is always FROM_NAME <FROM_EMAIL>. Gmail SMTP rewrites any other From to the login,
 * so passing the caller's tenant address would only look like it worked; the caller's
 * address becomes Reply-To instead (unless the caller set one), so a customer's reply still
 * reaches the tenant.
 *
 * Like Gmail, SMTP reports no bounces: "sent" means the server accepted the message.
 */
import nodemailer from "nodemailer";
import type { EmailAttachment } from "./send";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromEmail: string;
  fromName: string | null;
}

/** All five of host / port / user / pass / from must be set, or SMTP is off (null). */
export function smtpConfigFromEnv(env: Record<string, string | undefined>): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  const port = Number(env.SMTP_PORT?.trim());
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS?.trim();
  const fromEmail = env.FROM_EMAIL?.trim();
  if (!host || !user || !pass || !fromEmail || !Number.isInteger(port) || port <= 0) return null;
  return {
    host, port, user, pass, fromEmail,
    secure: env.SMTP_SECURE?.trim() === "true",
    fromName: env.FROM_NAME?.trim().replace(/^"(.*)"$/, "$1") || null,
  };
}

export interface SmtpMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  /** The caller's From. Not used as From (see header) — it becomes Reply-To. */
  callerFrom?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
}

export type SmtpResult = { ok: true; messageId: string | null } | { ok: false; detail: string };

type Transport = Pick<nodemailer.Transporter, "sendMail">;

let cached: { key: string; transport: Transport } | null = null;

function transportFor(cfg: SmtpConfig): Transport {
  const key = `${cfg.host}:${cfg.port}:${cfg.user}`;
  if (cached?.key === key) return cached.transport;
  const transport = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  cached = { key, transport };
  return transport;
}

export async function sendViaSmtp(
  msg: SmtpMessage,
  cfg: SmtpConfig,
  transport: Transport = transportFor(cfg),
): Promise<SmtpResult> {
  const from = cfg.fromName ? `"${cfg.fromName}" <${cfg.fromEmail}>` : cfg.fromEmail;
  try {
    const info = await transport.sendMail({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      replyTo: msg.replyTo || msg.callerFrom || undefined,
      attachments: msg.attachments?.map((a) => ({
        filename: a.filename,
        content: typeof a.content === "string" ? Buffer.from(a.content, "base64") : Buffer.from(a.content),
        contentType: a.contentType,
      })),
    });
    return { ok: true, messageId: info.messageId ?? null };
  } catch (err) {
    const e = err as { code?: string; response?: string; message?: string };
    return { ok: false, detail: [e.code, e.response || e.message].filter(Boolean).join(": ").slice(0, 300) };
  }
}
