/**
 * Gemini config resolver — single source of truth for "which API key + model
 * does this tenant's AI use?".
 *
 * Precedence:
 *   1. tenant_secrets.gemini_api_key  (set in Settings → Integrations → AI)
 *   2. process.env.GEMINI_API_KEY     (global Cloud Run fallback)
 *   3. null                           → callers use their deterministic stub
 *
 * Model: tenant_secrets.gemini_model → GEMINI_MODEL env → "gemini-1.5-flash".
 *
 * The raw key never leaves the server — callers use it to call the Gemini REST
 * API directly and only ever surface a masked preview in the integration UI.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";

export interface GeminiConfig {
  /** Usable API key, or null when neither tenant nor env has a valid one. */
  apiKey: string | null;
  model: string;
}

/**
 * MEASURED, not assumed — 23 Aug 2026, against the live API with a working key:
 *
 *   gemini-3.6-flash   200  "OK"
 *   gemini-2.5-flash   404  "This model models/gemini-2.5-flash is no longer available to
 *                            new users. Please update your code to use models/gemini-3.6-flash"
 *
 * gemini-1.5-* went the same way in 2025-26, and 2.5 has now followed for NEW keys. Note the
 * wording: "no longer available to NEW USERS". An existing key can keep working on a retired
 * model while a freshly created one 404s, so this line ages silently — nothing breaks until
 * somebody rotates a key, and then AI stops for a reason that has nothing to do with the
 * rotation. That is exactly how it was found: a 403 was fixed by a new key and became a 404.
 *
 * If AI drafting dies again, curl one model name before touching any code.
 *
 * ─── AND `ListModels` LIES, WHICH IS WORSE THAN BEING OUT OF DATE ───────────
 * Measured in the same sitting, with the same key:
 *
 *   ListModels reports  gemini-2.5-flash   →  calling it returns 404
 *   ListModels omits    gemini-3.6-flash   →  calling it returns 200
 *
 * So the discovery endpoint is not a source of truth for what will work, in either
 * direction. The old comment here already half-knew this ("the gemini-2.0-flash alias 404s
 * on some keys even when ListModels reports it") and still pinned a version.
 *
 * ─── WHY AN ALIAS, AND WHAT IT COSTS ───────────────────────────────────────
 * `gemini-flash-latest` is a ROLLING alias — verified 200 alongside 3.6-flash,
 * 3-flash-preview and 3.1-flash-lite. Pinning a version is what caused this outage: the
 * pin aged, silently, and nothing broke until a key was rotated.
 *
 * The cost is real and worth naming: the model behind this can change without a deploy, so
 * generated prose may shift. That is acceptable HERE and would not be everywhere, because
 * nothing downstream trusts the model with money or with facts — `verifyDraftMoney` allows
 * only figures already on the deal, `findPromises` refuses any price, date, discount or
 * guarantee before an unattended send, and `responseMimeType: application/json` pins the
 * response CONTRACT rather than the model. A model swap can make a reply read differently;
 * it cannot make it promise something.
 */
const DEFAULT_MODEL = "gemini-flash-latest";

function valid(key: string | null | undefined): string | null {
  const k = key?.trim();
  if (!k || k === "..." || k.length < 10) return null;
  return k;
}

/**
 * Resolve the Gemini config for a tenant. Pass any Supabase client that can read
 * `tenant_secrets` for this tenant (an admin client, or a session client whose
 * RLS already scopes to the tenant). `tenantId` may be omitted/null to use the
 * env fallback only.
 */
export async function resolveGeminiConfig(
  client: SupabaseClient<Database>,
  tenantId?: string | null,
): Promise<GeminiConfig> {
  let key = valid(process.env.GEMINI_API_KEY);
  let model = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;

  if (tenantId) {
    try {
      const { data } = await client
        .from("tenant_secrets")
        .select("gemini_api_key, gemini_model")
        .eq("tenant_id", tenantId)
        .maybeSingle();
      // Stored encrypted since the vault landed; plaintext rows pass through.
      const tenantKey = valid(decryptTenantSecrets(data)?.gemini_api_key);
      if (tenantKey) key = tenantKey;           // tenant key wins over env
      if (data?.gemini_model?.trim()) model = data.gemini_model.trim();
    } catch {
      // fall back to env on any read error
    }
  }

  return { apiKey: key, model };
}

// ─────────────────────────────────────────────────────────────────────────────
// Calling Gemini: timeout + circuit breaker
//
// Every AI route awaited a bare `fetch` with no timeout. Gemini is a third party
// on the far side of the internet; when it stalls rather than fails, the request
// stalls with it, and the operator watches a spinner until the platform kills the
// function. The AI here is always an enhancement over a deterministic stub, so
// waiting indefinitely for it is never the right trade.
// ─────────────────────────────────────────────────────────────────────────────

/** A slow draft is a failed draft — the stub is already good enough to send. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Consecutive failures before we stop calling, and how long we stay shut. */
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60_000;

/**
 * Circuit breaker state, module-scoped.
 *
 * Honest about what this is: on a serverless platform each warm instance keeps
 * its own copy, so this is not a cluster-wide breaker. It still does the thing
 * that matters — when Gemini is down, the instance stops paying the full timeout
 * on every single request and falls straight through to the deterministic stub.
 * A shared breaker would need Redis or a table, which is not worth it for a
 * feature whose failure mode is "slightly less personalised text".
 */
const breaker = { failures: 0, openedAt: 0 };

function breakerOpen(now: number): boolean {
  if (breaker.failures < BREAKER_THRESHOLD) return false;
  if (now - breaker.openedAt < BREAKER_COOLDOWN_MS) return true;
  // Cooldown elapsed — let one request through to test the water.
  breaker.failures = 0;
  return false;
}

function recordFailure(now: number) {
  breaker.failures += 1;
  if (breaker.failures >= BREAKER_THRESHOLD) breaker.openedAt = now;
}

/**
 * Call Gemini and parse a JSON response.
 *
 * Returns null on EVERY failure path — timeout, HTTP error, unparseable body,
 * open breaker. Callers already treat null as "use the deterministic stub", so
 * no AI failure can break a core flow. This never throws.
 */
export async function geminiJson<T>(args: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  temperature?: number;
  timeoutMs?: number;
  /** Prefix for server logs, e.g. "ai/draft-followup". */
  label: string;
}): Promise<T | null> {
  const now = Date.now();
  if (breakerOpen(now)) {
    console.warn(`[${args.label}] Gemini circuit breaker open — using stub`);
    return null;
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(args.model)}:generateContent?key=${args.apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: args.system }] },
          contents: [{ role: "user", parts: [{ text: args.user }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: args.temperature ?? 0.7,
          },
        }),
        signal: AbortSignal.timeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
    );

    if (!res.ok) {
      console.error(`[${args.label}] Gemini HTTP ${res.status}:`, await res.text().catch(() => ""));
      recordFailure(now);
      return null;
    }

    const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) { recordFailure(now); return null; }

    // Models still fence JSON in ```json blocks despite responseMimeType.
    const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(cleaned) as T;
    breaker.failures = 0;          // a success clears the count
    return parsed;
  } catch (err) {
    // AbortError (timeout), network failure, or malformed JSON all land here.
    const why = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError"
      ? `timed out after ${args.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
      : (err as Error)?.message;
    console.error(`[${args.label}] Gemini call failed — ${why}`);
    recordFailure(now);
    return null;
  }
}

/** Test-only: reset breaker state between cases. */
export function __resetGeminiBreaker() {
  breaker.failures = 0;
  breaker.openedAt = 0;
}
