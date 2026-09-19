/**
 * Sending through a plain SMTP relay.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Added 11 Sep 2026. Until then this app could send through Resend or a tenant's
 * Gmail and nothing else, and the DMS deployment — whose credentials this app is
 * meant to take over from — has neither. It has `SMTP_HOST` / `SMTP_PORT` /
 * `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE`, and sends everything through them.
 *
 * Measured before this was written: with the DMS environment loaded, every send
 * came back `Resend 401: API key is invalid`, so the new domain-expiry warnings
 * reached nobody. The logic was right and the envelope had nowhere to go.
 *
 * The env var names are DMS's names ON PURPOSE, so the credentials drop in with
 * no renaming and no chance of somebody mapping `SMTP_PASS` to the wrong key —
 * which is exactly the trap the ResellerClub variables set (DMS's
 * `RESELLERCLUB_ID` is our `RESELLERCLUB_RESELLER_ID`, and DMS has a differently
 * meaning variable of its own by that name).
 *
 * ─── SMTP IS IN GMAIL'S CATEGORY, NOT RESEND'S ──────────────────────────────
 * `provider.ts`'s whole design rests on one asymmetry: Resend reports bounces and
 * keeps a suppression list; Gmail reports nothing, so a dead address returns
 * success and the bounce arrives later as mail in the sender's inbox.
 *
 * A plain relay behaves like Gmail. A `250 OK` means the relay ACCEPTED the
 * message, not that anybody received it — the bounce comes back hours later to
 * whatever `SMTP_USER`'s mailbox is. So SMTP carries the same caution as Gmail
 * for bounce-sensitive mail, and it must never be presented as equivalent to
 * Resend. Saying otherwise would be the comfortable lie that turns a lapsed
 * renewal into a mystery.
 *
 * ─── ONE TRANSPORTER, CREATED ONCE ──────────────────────────────────────────
 * A module-level singleton, because building a transporter per message means a
 * fresh TCP connection and TLS handshake per message, and a cron sending fifty
 * expiry warnings would do fifty. Pooling is left OFF: these are short bursts
 * from a request-scoped server, and a pooled connection held open across a Cloud
 * Run instance's idle period is a connection the relay will have closed without
 * telling us.
 *
 * ─── EVERY TIMEOUT IS SET ───────────────────────────────────────────────────
 * Nodemailer's defaults are generous (two minutes to connect). A cron that
 * blocks two minutes on one unreachable relay does not finish its batch, and on
 * Cloud Run it may be killed mid-run — which is how a queue becomes a backlog
 * nobody drains. Ten seconds each, and a failure is a result rather than a throw.
 */
import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import type { EmailAttachment } from "./send";

const HOST = process.env.SMTP_HOST?.trim() || "";
const PORT = Number(process.env.SMTP_PORT?.trim() || "");
const USER = process.env.SMTP_USER?.trim() || "";
const PASS = process.env.SMTP_PASS?.trim() || "";
const SECURE_RAW = process.env.SMTP_SECURE?.trim().toLowerCase() || "";
/** Optional. Falls back to `SMTP_USER`, which is the identity the relay owns. */
const FROM = process.env.SMTP_FROM?.trim() || "";

/**
 * Implicit TLS (port 465) or STARTTLS (587 and friends)?
 *
 * `SMTP_SECURE` wins when set, because the operator knows their relay. With it
 * unset the PORT decides, which is the convention every relay follows — and
 * guessing `true` on 587 fails the handshake with a message about the wrong
 * version number, which reads as a certificate problem and sends people the
 * wrong way for an hour.
 */
function isSecure(): boolean {
  if (SECURE_RAW === "true" || SECURE_RAW === "1" || SECURE_RAW === "yes") return true;
  if (SECURE_RAW === "false" || SECURE_RAW === "0" || SECURE_RAW === "no") return false;
  return PORT === 465;
}

/** Host, port and both credentials. A relay that needs no auth is not supported. */
export function smtpConfigured(): boolean {
  return HOST.length > 0 && Number.isFinite(PORT) && PORT > 0 && USER.length > 0 && PASS.length > 0;
}

/** For the operator-facing readiness copy. Never the password. */
export function smtpDescription(): string {
  if (!smtpConfigured()) return "SMTP is not configured";
  return `SMTP ${HOST}:${PORT} as ${USER} (${isSecure() ? "TLS" : "STARTTLS"})`;
}

/**
 * The From this relay is actually allowed to use.
 *
 * ─── WHY THE CALLER'S `from` IS NOT TRUSTED HERE ────────────────────────────
 * A relay sends as the identity it authenticated with. Measured 11 Sep 2026: the
 * DMS credentials are `smtp.gmail.com:587` as `noreply@anutech.in` with an app
 * password — and Gmail refuses, or silently rewrites, a From it has not verified
 * for that account.
 *
 * Meanwhile almost every caller in this app passes
 * `from: RESEND_FROM_DEFAULT` which is `onboarding@resend.dev` when unset — a
 * Resend sandbox address that means nothing to Gmail. Passing it through would
 * turn "email works now" into "email is rejected with 5.7.0, on every message,
 * for a reason that reads like a certificate problem".
 *
 * So the relay's own identity wins, and the caller's intended address is not
 * thrown away: it becomes `Reply-To` when the caller did not set one, so a
 * customer hitting reply still reaches the reseller rather than a no-reply box.
 *
 * `SMTP_FROM` exists for the case where the relay IS allowed a nicer display
 * address than the login (a Workspace "send mail as" alias, typically).
 */
export function smtpFrom(): string {
  return FROM || USER;
}

export type SmtpSendResult =
  | { ok: true; messageId: string }
  | { ok: false; detail: string; retryable: boolean };

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;
  const options: SMTPTransport.Options = {
    host: HOST,
    port: PORT,
    secure: isSecure(),
    auth: { user: USER, pass: PASS },
    /* See the header — the defaults are minutes, and a cron cannot afford them. */
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
    /* No `pool` key: pooling is a DIFFERENT nodemailer transport, and the plain
       SMTP one is unpooled already. Passing `pool: false` here does not
       type-check, and passing `pool: true` would silently select the other
       transport — see the header for why that is not wanted. */
  };
  transporter = nodemailer.createTransport(options);
  return transporter;
}

/**
 * Connect and authenticate WITHOUT sending anything.
 *
 * The honest way to answer "do these credentials work?" — and the only one that
 * does not put a test message in somebody's inbox. Used by the readiness check
 * and by hand when credentials change.
 */
export async function smtpVerify(): Promise<{ ok: boolean; detail: string }> {
  if (!smtpConfigured()) {
    return { ok: false, detail: "SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS are not all set." };
  }
  try {
    await getTransporter().verify();
    return { ok: true, detail: smtpDescription() };
  } catch (e) {
    /* The relay's own words. "Invalid login" and "connection refused" send an
       operator to different places, and a generic message sends them nowhere. */
    return { ok: false, detail: (e as Error).message.slice(0, 300) };
  }
}

export interface SmtpSendInput {
  to: string;
  from: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
}

/**
 * Send one message. Returns a result rather than throwing — every caller is a
 * cron or a webhook where one bad address must not abort the batch.
 */
export async function sendViaSmtp(input: SmtpSendInput): Promise<SmtpSendResult> {
  if (!smtpConfigured()) {
    return {
      ok: false,
      retryable: false,
      detail: "SMTP is not configured on this server (SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS).",
    };
  }

  /* See `smtpFrom`. The caller's address becomes Reply-To rather than being
     discarded — but only when it is a real address and not the Resend sandbox
     default, and only when the caller has not set a Reply-To of its own. */
  const envelopeFrom = smtpFrom();
  const callerFrom = input.from?.trim();
  const replyTo =
    input.replyTo?.trim() ||
    (callerFrom && callerFrom !== envelopeFrom && !/@resend\.dev>?$/i.test(callerFrom)
      ? callerFrom
      : undefined);

  try {
    const info = await getTransporter().sendMail({
      to: input.to,
      from: envelopeFrom,
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(input.attachments?.length
        ? {
            attachments: input.attachments.map((a) => ({
              filename: a.filename,
              /* A base64 STRING or a Buffer. `EmailAttachment.content` also
                 permits `Uint8Array`, which nodemailer does not take — wrapping
                 it costs nothing and avoids an attachment that silently arrives
                 as zero bytes. Naming the encoding for the string case stops it
                 being attached as literal base64 text. */
              content:
                typeof a.content === "string" || Buffer.isBuffer(a.content)
                  ? a.content
                  : Buffer.from(a.content),
              ...(typeof a.content === "string" ? { encoding: "base64" as const } : {}),
              ...(a.contentType ? { contentType: a.contentType } : {}),
            })),
          }
        : {}),
    });

    /* `messageId` is the Message-ID header, which is what a bounce quotes back —
       so it is the only id worth recording for a transport that reports nothing
       else. `rejected` is checked because a relay can accept the envelope and
       refuse one recipient in the same response, and we send to one address. */
    if (info.rejected?.length) {
      return {
        ok: false,
        retryable: false,
        detail: `The relay refused ${info.rejected.join(", ")}${info.response ? ` — ${info.response}` : ""}`,
      };
    }
    return { ok: true, messageId: String(info.messageId ?? "") };
  } catch (e) {
    const message = (e as Error).message || "SMTP send failed";
    /* Auth and a refused recipient will not fix themselves; a timeout or a
       dropped connection might. The caller uses this to decide whether the row
       goes back in the queue. */
    const permanent = /invalid login|authentication|auth failed|5\.\d\.\d|550|553|554/i.test(message);
    return { ok: false, retryable: !permanent, detail: message.slice(0, 300) };
  }
}

/** Test seam only — forces the next call to build a fresh transporter. */
export function __resetSmtpTransporterForTests(): void {
  transporter = null;
}
