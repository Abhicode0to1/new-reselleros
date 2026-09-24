import "server-only";

/**
 * The shared "one free trial per customer" record, which lives in DMS.
 *
 * Owner rule, 24 Sep 2026: one free hosting trial per customer, across BOTH apps.
 * DMS can see its own trials, and ResellerOS can reach DMS, but DMS cannot reach
 * ResellerOS. So DMS keeps the union (its model ExternalTrial plus its own orders
 * and hostings), and this app:
 *   1. asks it before starting a trial — `checkTrialHistory`;
 *   2. tells it after starting one — `recordTrialInDms`, so a later trial in the
 *      DMS customer panel on the same email, phone or domain is refused there.
 *
 * DMS side: app/api/integrations/engine/trials/route.ts, lib/trials/trial-history.ts.
 */

const BASE_URL = (process.env.DMS_ENGINE_URL ?? "").trim().replace(/\/+$/, "");
const READ_KEY = (process.env.DMS_ENGINE_READ_KEY ?? "").trim();
const COMMAND_KEY = (process.env.DMS_ENGINE_COMMAND_KEY ?? "").trim();
const TIMEOUT_MS = 8000;

export interface TrialIdentity {
  email: string;
  phone?: string;
  domain?: string;
}

export type TrialHistory =
  | { ok: true; trialled: false }
  | { ok: true; trialled: true; where: "reselleros" | "dms"; startedAt: string | null }
  | { ok: false; reason: string };

async function call(path: string, init: RequestInit & { key: string }): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), "x-integration-key": init.key, accept: "application/json" },
      signal: controller.signal,
      // A cached "not trialled" would hand a second trial to someone who just had one.
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Has this customer had a free trial in either app? Never answers "no" when it
 * does not know: an unconfigured, unreachable or failing DMS is `ok: false`, and
 * the caller refuses the trial (AGENTS.md §2).
 */
export async function checkTrialHistory(id: TrialIdentity): Promise<TrialHistory> {
  if (!BASE_URL || !READ_KEY) return { ok: false, reason: "DMS_ENGINE_URL / DMS_ENGINE_READ_KEY are not set on this server" };
  const qs = new URLSearchParams({ email: id.email });
  if (id.phone) qs.set("phone", id.phone);
  if (id.domain) qs.set("domain", id.domain);
  try {
    const res = await call(`/api/integrations/engine/trials?${qs.toString()}`, { method: "GET", key: READ_KEY });
    if (!res.ok) return { ok: false, reason: `DMS answered HTTP ${res.status}` };
    const body = (await res.json()) as { trialled?: unknown; where?: unknown; startedAt?: unknown };
    if (body.trialled === false) return { ok: true, trialled: false };
    if (body.trialled === true && (body.where === "reselleros" || body.where === "dms")) {
      return { ok: true, trialled: true, where: body.where, startedAt: typeof body.startedAt === "string" ? body.startedAt : null };
    }
    return { ok: false, reason: "DMS gave an answer this app does not understand" };
  } catch (err) {
    return { ok: false, reason: `DMS did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Record a trial this app started. Idempotent on `ref` (the lead id), so a retry is harmless. */
export async function recordTrialInDms(input: TrialIdentity & { ref: string; planId: string; cycle: "monthly" | "yearly" }): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!BASE_URL || !COMMAND_KEY) return { ok: false, reason: "DMS_ENGINE_URL / DMS_ENGINE_COMMAND_KEY are not set on this server" };
  try {
    const res = await call("/api/integrations/engine/trials", {
      method: "POST",
      key: COMMAND_KEY,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return res.ok ? { ok: true } : { ok: false, reason: `DMS answered HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: `DMS did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }
}
