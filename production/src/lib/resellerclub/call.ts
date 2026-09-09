/**
 * ResellerClub transport — ONE normaliser, shared by every write module.
 *
 * ─── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────
 * It lived inside `orders.ts` until 9 Sep 2026, private to it. `customers.ts`
 * needs exactly the same call semantics, and the alternative was a second copy.
 * A second copy is how DMS got the defect this repo has already had to catch
 * once: its `renewDomain`/`transferDomain` never read RC's in-body
 * `{"status":"ERROR"}` on an HTTP 200, so a refused renewal was recorded as
 * renewed. That happened because each operation carried its own transport. One
 * file, one set of RC quirks, or the next module re-learns them wrongly.
 *
 * Moved verbatim; the only addition is `allowScalar` (see below).
 */
import "server-only";
import type { RcRawResponse } from "./classify";

const BASE = (process.env.RESELLERCLUB_API_URL?.trim() || "https://httpapi.com").replace(/\/+$/, "");
const RESELLER_ID = process.env.RESELLERCLUB_RESELLER_ID?.trim() || "";
const API_KEY = process.env.RESELLERCLUB_API_KEY?.trim() || "";

/** Credentials present. NOT permission to order — see `rcOrderingEnabled`. */
export function rcWriteConfigured(): boolean {
  return RESELLER_ID.length > 0 && API_KEY.length > 0;
}

/** The money gate. Both halves, in one place, so a call site cannot check half. */
export function rcOrderingEnabled(): boolean {
  return rcWriteConfigured() && process.env.DOMAIN_REGISTER_LIVE === "1";
}

export interface RcCallOptions {
  /**
   * Accept a bare JSON scalar as a success body, surfaced as `data.value`.
   *
   * Needed because RC is not consistent about this. `domains/register.json`
   * answers with an object, but `customers/signup.json` and `contacts/add.json`
   * answer with a BARE NUMBER — the new id, e.g. `12345`. `JSON.parse("12345")`
   * is a number, so the object check below would call the id "an unreadable
   * body" and every successful customer creation would read as a failure. This
   * was measured before writing customers.ts, not discovered afterwards.
   *
   * Off by default so the order path keeps its stricter contract unchanged.
   */
  allowScalar?: boolean;
}

/**
 * One call to ResellerClub, normalised into the three words `classify.ts`
 * understands.
 *
 * RC's conventions, all of which this has to absorb:
 *   · credentials go in the QUERY STRING on every request, including POSTs —
 *     there is no header auth;
 *   · errors come back with HTTP 200 and `{"status":"ERROR","message":…}`, or
 *     sometimes `{"error": "…"}` with no status at all;
 *   · `status` casing is inconsistent, hence the lowercase compare;
 *   · `"InvoicePaid"` with an error attached means the money moved but the
 *     order has not completed — pending, never a failure (observed by the
 *     engine; see its registration.ts).
 *   · some endpoints answer with a bare scalar id — see `allowScalar`.
 */
export async function rcCall(
  path: string,
  params: Record<string, string | string[]>,
  method: "GET" | "POST",
  opts: RcCallOptions = {},
): Promise<RcRawResponse> {
  if (!rcWriteConfigured()) {
    return { status: "error", message: "ResellerClub credentials are not configured in this environment" };
  }

  const qs = new URLSearchParams();
  qs.set("auth-userid", RESELLER_ID);
  qs.set("api-key", API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((item) => qs.append(k, item));
    else if (v !== "") qs.set(k, v);
  }

  const url = `${BASE}${path}?${qs.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      cache: "no-store",
      /* 60s, not the read side's 15s. A registration is a registry round-trip
         and RC is routinely slow on it; timing out early does not cancel the
         order, it only loses our record of it. */
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    /* The URL is never logged — it carries the api-key in the query string. */
    const message = (err as Error).message || "unreachable";
    console.error(`[resellerclub] ${path} unreachable: ${message}`);
    return { status: "error", message: `ResellerClub unreachable: ${message}` };
  }

  const text = await res.text().catch(() => "");

  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  const asRecord = body && typeof body === "object" ? (body as Record<string, unknown>) : null;

  if (!res.ok) {
    /* A non-2xx still often carries RC's reason in the body — prefer it over
       the bare status code, because "IP not whitelisted" is actionable and
       "HTTP 403" is not (§24). */
    const message =
      (typeof asRecord?.message === "string" && asRecord.message) ||
      (typeof asRecord?.error === "string" && asRecord.error) ||
      `ResellerClub HTTP ${res.status}: ${text.slice(0, 200)}`;
    console.error(`[resellerclub] ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
    return { status: "error", message, data: asRecord ?? undefined };
  }

  /* A bare id, for the endpoints that answer with one. Checked BEFORE the
     object guard below, and only when the caller asked for it. */
  if (!asRecord && opts.allowScalar && (typeof body === "number" || typeof body === "string")) {
    const value = String(body).trim();
    if (value.length > 0) return { status: "success", data: { value } };
  }

  if (!asRecord) {
    return { status: "error", message: `ResellerClub returned an unreadable body: ${text.slice(0, 200)}` };
  }

  const rawStatus = typeof asRecord.status === "string" ? asRecord.status.toLowerCase() : "";

  /* The money moved but the order has not landed. Pending, not an error. */
  if (rawStatus === "invoicepaid") {
    return {
      status: "pending",
      message: typeof asRecord.message === "string" ? asRecord.message : "invoice paid, order not yet complete",
      data: asRecord,
    };
  }

  if (rawStatus === "error" || typeof asRecord.error === "string") {
    const message =
      (typeof asRecord.message === "string" && asRecord.message) ||
      (typeof asRecord.error === "string" && asRecord.error) ||
      "ResellerClub reported an error with no message";
    return { status: "error", message, data: asRecord };
  }

  return { status: "success", data: asRecord };
}
