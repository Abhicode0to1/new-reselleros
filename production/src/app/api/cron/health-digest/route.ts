/**
 * GET|POST /api/cron/health-digest — production ke logs padho, kuch bigda ho to email karo.
 *
 * Schedule: roz 08:30 IST, Cloud Scheduler se. `?hours=` se khidki badal sakti hai.
 * Haath se: `curl -H "Authorization: Bearer <CRON_SECRET>" .../api/cron/health-digest`
 *
 * ─── YE KYUN HAI ────────────────────────────────────────────────────────────
 * 28 Aug 2026 ko production ke logs pehli baar khule aur ek ghante me teen bug nikle jo
 * hafton se chal rahe the — ek kho gaya customer reply, 7 vendor invoice, aur har request
 * ke saath log me jaata hua secret. Teeno isliye mile ki us din kisi ne jaakar dekha.
 *
 * `npm run health:prod` usi din bana, par use bhi koi chalata hai tab hi chalta hai. Ye wahi
 * chaar sawaal roz poochhta hai, bina kisi ke.
 *
 * ─── CHUP RAHNA DEFAULT HAI ─────────────────────────────────────────────────
 * Sab theek ho to ye kuch NAHI bhejta. Ek roz aane wali "sab theek hai" email do hafte me
 * padhi jaani band ho jaati hai, aur phir wo din bhi nahi padhi jaati jab usme kuch hota
 * hai. Isliye email sirf tab jab kuch kehne layak ho — aur response hamesha poora digest
 * lautata hai, taaki haath se chalane par sab dikhe.
 *
 * ─── IAM ────────────────────────────────────────────────────────────────────
 * Cloud Run ka runtime service account Cloud Logging padh sake, iske liye ek role chahiye:
 *
 *   gcloud projects add-iam-policy-binding resellsubsos-prod \
 *     --member="serviceAccount:1005662057478-compute@developer.gserviceaccount.com" \
 *     --role="roles/logging.viewer" --condition=None
 *
 * Wo role na ho to ye 403 par saaf yahi command lautata hai — chup-chaap khaali digest nahi
 * deta, kyunki "kuch nahi mila" aur "padh hi nahi paya" ek jaise dikhne se hi aaj ke teen
 * bug hafton chhupe rahe the.
 *
 * Koi nayi dependency nahi: token metadata server se, logs REST se (CLAUDE.md §17).
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { sendEmail } from "@/lib/email/send";
import { buildDigest, digestText, type LogRow } from "@/lib/ops/health-digest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROJECT = "resellsubsos-prod";
const SERVICE = "resellersos";
const LOG_SA = "1005662057478-compute@developer.gserviceaccount.com";
const GRANT_CMD =
  `gcloud projects add-iam-policy-binding ${PROJECT} ` +
  `--member="serviceAccount:${LOG_SA}" --role="roles/logging.viewer" --condition=None`;

/** Cloud Run ke metadata server se token — koi key file, koi env var nahi. */
async function metadataToken(): Promise<string | null> {
  try {
    const r = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5_000) },
    );
    if (!r.ok) return null;
    return ((await r.json()) as { access_token?: string }).access_token ?? null;
  } catch {
    /* Local dev me metadata server hota hi nahi — wahan ye route chalega hi nahi, aur
       chalna bhi nahi chahiye. */
    return null;
  }
}

interface Entry {
  timestamp?: string;
  textPayload?: string;
  httpRequest?: { status?: number; requestUrl?: string };
}

async function readLogs(token: string, filter: string, limit: number): Promise<Entry[] | "denied"> {
  const r = await fetch("https://logging.googleapis.com/v2/entries:list", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      resourceNames: [`projects/${PROJECT}`],
      filter,
      orderBy: "timestamp desc",
      pageSize: limit,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (r.status === 403) return "denied";
  if (!r.ok) throw new Error(`logging ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return ((await r.json()) as { entries?: Entry[] }).entries ?? [];
}

const toRows = (e: Entry[]): LogRow[] => e.map((x) => ({
  timestamp: x.timestamp ?? "",
  status: x.httpRequest?.status ?? null,
  url: x.httpRequest?.requestUrl ?? null,
  text: x.textPayload ?? null,
}));

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }

async function handle(req: Request) {
  /* Fail closed, baaki cron ki tarah: ye route production ke logs padhta hai. */
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const hours = Math.min(168, Math.max(1, Number(new URL(req.url).searchParams.get("hours")) || 24));
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const base =
    `resource.type="cloud_run_revision" AND resource.labels.service_name="${SERVICE}" ` +
    `AND timestamp>="${since}"`;

  const token = await metadataToken();
  if (!token) {
    return NextResponse.json(
      { error: "no metadata token — this route only runs on Cloud Run" },
      { status: 503 },
    );
  }

  let http: Entry[] | "denied";
  let stderr: Entry[] | "denied";
  try {
    [http, stderr] = await Promise.all([
      readLogs(token, `${base} AND (httpRequest.status>=500 OR httpRequest.status=401)`, 400),
      readLogs(token, `${base} AND logName:"stderr"`, 400),
    ]);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }

  if (http === "denied" || stderr === "denied") {
    /* §24: kya hua, kyun, ab kya karein — aur wo "ab kya" ek command hai jo paste ho sake. */
    return NextResponse.json({
      error: "Cloud Logging refused this service account, so nothing could be read.",
      fix: GRANT_CMD,
    }, { status: 403 });
  }

  const digest = buildDigest(hours, { http: toRows(http), stderr: toRows(stderr) });

  if (digest.clean) return NextResponse.json({ ok: true, clean: true, hours });

  /* Kise bhejein: is tenant ka owner. Ek hi tenant ka digest — ye ops ka mail hai, tenant
     ka nahi, isliye platform ke owner par jata hai. */
  const admin = createAdminClient();
  const { data: owner } = await admin
    .from("users").select("email").eq("role", "owner")
    .order("created_at", { ascending: true }).limit(1).maybeSingle();
  const to = (owner as { email?: string } | null)?.email ?? null;
  if (!to) {
    return NextResponse.json({ ok: true, clean: false, emailed: false, reason: "no owner email", digest });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const worst = digest.serverErrors[0] ?? digest.refused[0] ?? digest.appErrors[0];
  const sent = await sendEmail({
    to,
    subject: `ResellerOS — ${worst ? worst.what.slice(0, 60) : "kuch dekhne layak hai"}`,
    text: digestText(digest, appUrl),
  });

  return NextResponse.json({
    ok: true, clean: false, emailed: sent.status === "sent", to, digest,
    emailError: sent.errorMessage,
  });
}
