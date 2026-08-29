/**
 * Nightly backup cron — one restore point per tenant, every night.
 *
 * Schedule: 00:00 IST via CLOUD SCHEDULER (scripts/setup-cloud-scheduler.sh).
 * NOT vercel.json — the live deployment is Cloud Run, where Vercel crons do not
 * exist and that file is inert. Registering it there would produce a job that
 * looks scheduled in the repo and never runs, which for a backup is the worst
 * possible failure: you find out it was never running on the day you need it.
 *
 * ─── WHY THIS ROUTE EXISTS AT ALL ───────────────────────────────────────────
 * The in-app backup was owner-triggered, plus `auto_backup_if_stale()` (0212)
 * which fires only when somebody OPENS Settings → Backup. So a tenant whose owner
 * does not visit that page had no automatic protection — and that is exactly the
 * tenant that will one day need it. Meanwhile the page already promised restore
 * points are taken "apne aap roz". This makes the promise true.
 *
 * ─── ORDER OF THE GUARDS ────────────────────────────────────────────────────
 * Fail closed on a missing secret (503) BEFORE looking at the header, and use a
 * constant-time compare — the same shape as the other five crons here, on
 * purpose: an endpoint that snapshots every tenant is the last one that should
 * have its own bespoke auth.
 *
 * Local: curl -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/cron/backup
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { runSweepWithRetry } from "@/lib/backup/sweep-retry";
import { reportCron } from "@/lib/ops/cron-report";
import {
  OFFSITE_BUCKET,
  offsiteObjectName,
  offsiteWindowStart,
  offsiteEnvelope,
  offsiteRefusal,
  type OffsiteSnapshot,
} from "@/lib/backup/offsite";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Snapshot ko database ke BAHAR rakho — Cloud Storage par, doosre region me.
 *
 * `backup.snapshots` usi database ke andar hai jiska wo backup hai. Wo backup ek galat DELETE
 * se bachata hai, project khone se nahi. Ye function doosri wali soorat sambhalta hai.
 *
 * Wapas `null` (sab theek) ya wajah (jo stderr par ja kar agli subah digest me dikhegi).
 * Chahe kuch bhi ho, poore cron ko fail NAHI karta: DB ka backup ho chuka hota hai, aur 500
 * lautane par Scheduler poora sweep dobara chalata — off-site ki naakami ka ilaaj us DB
 * backup ko dobara lena nahi hai.
 */
async function putOffsite(admin: ReturnType<typeof createAdminClient>): Promise<string | null> {
  const now = new Date();

  const { data, error } = await admin.rpc("export_snapshots_for_offsite", {
    p_since: offsiteWindowStart(now).toISOString(),
  });
  if (error) return `snapshot padhe nahi ja sake: ${error.message}`;

  /* Ginti DB se, taaki "kitne tenant hone chahiye" ek hardcoded number na ho jo naye tenant
     par chup-chaap galat ho jaye. Ginti na mile to us wajah se backup rokna galat hoga —
     `offsiteRefusal` 0 ko "ginti nahi pata" maanta hai, "koi tenant nahi" nahi. */
  const { count } = await admin.from("tenants").select("id", { count: "exact", head: true });

  const env = offsiteEnvelope(
    now,
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/^https?:\/\//, "").split(".")[0] || "unknown",
    (data ?? []) as OffsiteSnapshot[],
  );

  const refusal = offsiteRefusal(env, count ?? 0);
  if (refusal) return refusal;

  /* Token metadata server se — koi key file, koi env var, koi nayi dependency (CLAUDE.md §17).
     Local dev me metadata server hota hi nahi, aur wahan ye chalna bhi nahi chahiye. */
  let token: string;
  try {
    const r = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5_000) },
    );
    if (!r.ok) return `metadata token nahi mila: ${r.status}`;
    const t = ((await r.json()) as { access_token?: string }).access_token;
    if (!t) return "metadata token khaali aaya";
    token = t;
  } catch {
    return "metadata server tak nahi pahunch paye — ye route sirf Cloud Run par chalta hai";
  }

  const name = offsiteObjectName(now);
  const up = await fetch(
    `https://storage.googleapis.com/upload/storage/v1/b/${OFFSITE_BUCKET}/o` +
      `?uploadType=media&name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(env),
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!up.ok) {
    /* §24: kya hua, kyun, ab kya. 403 ka matlab lagbhag hamesha ek hi cheez hai. */
    const body = (await up.text()).slice(0, 200);
    const hint = up.status === 403
      ? ` — bucket par grant chahiye: gcloud storage buckets add-iam-policy-binding gs://${OFFSITE_BUCKET}` +
        ` --member="serviceAccount:1005662057478-compute@developer.gserviceaccount.com" --role="roles/storage.objectAdmin"`
      : "";
    return `upload ${up.status}: ${body}${hint}`;
  }

  console.log(`[cron/backup] off-site: gs://${OFFSITE_BUCKET}/${name} — ${env.tenant_count} tenant`);
  return null;
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: "cron not configured" }, { status: 503 });

  const header = req.headers.get("authorization") ?? "";
  const match  = /^Bearer\s+(.+)$/i.exec(header);
  if (!timingSafeEqualStr(match?.[1] ?? "", secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  /* Retried, because on 21 Aug 2026 this exact call answered "JWT issued at future"
   * once and the night's backup was simply never taken — the Cloud Scheduler job has
   * no retryCount, so nothing tried again until the next midnight. Only failures a
   * second attempt could survive are retried; see lib/backup/sweep-retry.ts, which
   * refuses to retry a bad grant or an unapplied migration on purpose. */
  const run = await runSweepWithRetry(async () => {
    const { data, error } = await admin.rpc("backup_all_tenants", { p_label: null });
    return error ? { ok: false as const, message: error.message } : { ok: true as const, data };
  });

  /* Logged even when the retry WORKED. A backup that only succeeds on the second try
   * is still a warning worth reading — silently absorbing it is how a clock drifting
   * further every night stays invisible until the night it exceeds the retry budget. */
  if (run.retriedBecause.length > 0) {
    console.warn(
      `[cron/backup] retried ${run.retriedBecause.length}x — ${run.retriedBecause.join(" | ")}`,
    );
  }

  if (!run.result.ok) {
    /* Keeps the "[cron/backup] sweep failed" prefix the 21 Aug incident was found by,
     * so any log filter or search built on it still matches — with the attempt count
     * added, which is the thing that was missing that night. */
    console.error(
      `[cron/backup] sweep failed after ${run.attemptsMade} attempt(s):`,
      run.result.message,
    );
    return NextResponse.json(
      { ok: false, error: run.result.message, attempts: run.attemptsMade },
      { status: 500 },
    );
  }

  const result = run.result.data;

  /* The function's `ok` is a COUNT of tenants; the response's `ok` is a boolean
   * for the caller. Spreading one over the other silently overwrote the count,
   * so the fields are mapped by hand and renamed to say what they are. */
  const body = {
    label:      result.label,
    backed_up:  result.ok,
    failed:     result.failed,
    total_bytes: result.total_bytes,
    results:    result.results,
  };

  /* A partial failure is reported, not swallowed. One tenant without tonight's
   * backup means the scheduler must see a non-2xx, or the run shows up green
   * with a note nobody reads. The tenants that DID succeed keep their snapshots
   * either way — the sweep never rolls back for one bad tenant. */
  if (result.failed > 0) {
    const broken = result.results.filter((r) => !r.ok).map((r) => `${r.tenant}: ${r.error}`);
    console.error("[cron/backup] some tenants failed:", broken.join(" | "));
    return NextResponse.json({ ok: false, ...body }, { status: 500 });
  }

  console.log(`[cron/backup] ${result.label} — ${result.ok} tenants, ${result.total_bytes} bytes`);

  /* DB ka backup ho chuka. Ab uski ek copy database ke BAHAR — kyunki `backup.snapshots`
     usi project me hai, aur project khone par backup bhi saath chala jayega.

     Naakami response ko 500 nahi banati (upar wali tippani dekhein), par chup bhi nahi
     rehti: `errors` me jaakar `reportCron` se stderr par likhi jaati hai, aur agli subah
     08:30 wali health digest use utha leti hai. Ek backup jo chup-chaap band pad jaye wo
     backup na hone se bura hai — kyunki dikhta hai backup jaisa. */
  const offsiteError = await putOffsite(admin);

  return NextResponse.json(reportCron("backup", {
    ok: true,
    ...body,
    offsite: offsiteError ? "failed" : "ok",
    errors: offsiteError ? [`off-site copy: ${offsiteError}`] : [],
  }));
}
