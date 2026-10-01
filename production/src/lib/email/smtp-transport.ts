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
import { lookup } from "node:dns/promises";
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

let cached: { key: string; transport: Transport; at: number } | null = null;
/** Re-resolve the SMTP host this often, so a moved server is followed. */
const TRANSPORT_TTL_MS = 10 * 60 * 1000;

/**
 * Connect over IPv4, found 30 Sep 2026. nodemailer resolved smtp.gmail.com to an IPv6
 * address first; this machine (and Cloud Run, which has no IPv6 egress by default) cannot
 * reach it, so the first send of every server process hung for 21 s — the TCP connect
 * timeout — before nodemailer fell back to IPv4. That was the 25-second "Starting your
 * trial…" wait. The IPv4 address is resolved here and the TLS certificate is still checked
 * against the real host name (`servername`). If the IPv4 lookup itself fails, the name is
 * handed to nodemailer as before.
 */
export async function ipv4For(host: string, resolve = lookup): Promise<string | null> {
  try {
    const a = await resolve(host, { family: 4 });
    return a.address;
  } catch {
    return null;
  }
}

async function transportFor(cfg: SmtpConfig): Promise<Transport> {
  const key = `${cfg.host}:${cfg.port}:${cfg.user}`;
  if (cached?.key === key && Date.now() - cached.at < TRANSPORT_TTL_MS) return cached.transport;
  const ip = await ipv4For(cfg.host);
  const transport = nodemailer.createTransport({
    host: ip ?? cfg.host, port: cfg.port, secure: cfg.secure,
    tls: { servername: cfg.host },
    auth: { user: cfg.user, pass: cfg.pass },
    // SMTP_DEBUG=1 logs every step of the SMTP conversation with timestamps, for
    // diagnosing a slow or failing send.
    ...(process.env.SMTP_DEBUG === "1" ? { logger: true, debug: true } : {}),
  });
  cached = { key, transport, at: Date.now() };
  return transport;
}

export async function sendViaSmtp(
  msg: SmtpMessage,
  cfg: SmtpConfig,
  transport?: Transport,
): Promise<SmtpResult> {
  const from = cfg.fromName ? `"${cfg.fromName}" <${cfg.fromEmail}>` : cfg.fromEmail;
  try {
    const t = transport ?? (await transportFor(cfg));
    const info = await t.sendMail({
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
