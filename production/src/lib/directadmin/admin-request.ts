/**
 * DirectAdmin's ADMIN transport — acting as the reseller itself.
 *
 * The sibling of `user-auth.ts`, which acts AS a hosting user. Which one a call
 * needs is not a style choice: an admin-context DNS read returns the reseller's
 * own zone, and a user-context `CMD_API_SHOW_USERS` returns nothing useful. The
 * two files exist so that choice has to be made explicitly, by import.
 *
 * ─── WHY IT REPORTS *HOW* IT FAILED ──────────────────────────────────────────
 * `index.ts`'s daGet returns null and `provision.ts`'s daPost returns a message.
 * Both throw away the two things a caller needs to decide what to do next: the
 * HTTP status, and whether DirectAdmin answered at all. Without them "the user is
 * gone, mark the row orphaned" is indistinguishable from "DA is having a bad
 * minute, try again in five" — and a sweep that guesses wrong either deletes live
 * records or never notices a real orphan.
 *
 * So a failure here carries a `transport` discriminator:
 *   · `network`    — never reached DA. Always retryable.
 *   · `http`       — DA's front end answered with a status; 502/503/504 are its
 *                    backend being down, which is retryable, and the rest is not.
 *   · `envelope`   — HTTP 200 with `error=1&text=…`. DA UNDERSTOOD the request and
 *                    said no; the text is the only place the reason exists, so it
 *                    is carried verbatim for `classify.ts` to match against.
 *   · `login_page` — HTML back instead of a response. The calling IP is not on
 *                    DA's allowlist, or the key is wrong. Never a per-user fact,
 *                    and never worth retrying on a schedule.
 *
 * ─── ON THE TWO OLDER COPIES ─────────────────────────────────────────────────
 * `index.ts` and `provision.ts` still have their own inline transports. Moving
 * them onto this one is a separate change on purpose: they are behind 22 passing
 * tests and a live provisioning path, and folding that refactor into a port would
 * make both halves harder to review. This file is where new callers go.
 */
import "server-only";

const DA_URL = (process.env.DIRECTADMIN_URL?.trim() || "").replace(/\/+$/, "");
const ADMIN_USER = process.env.DIRECTADMIN_ADMIN_USER?.trim() || "";
const API_KEY = process.env.DIRECTADMIN_API_KEY?.trim() || "";

export function daAdminConfigured(): boolean {
  return DA_URL.length > 0 && ADMIN_USER.length > 0 && API_KEY.length > 0;
}

export type DaTransportFailure = "network" | "http" | "envelope" | "login_page";

export type DaAdminResponse =
  /** DA answered, and it was not a refusal. `text` is raw — this does not parse. */
  | { kind: "ok"; text: string }
  /** OUR precondition failed. Nothing was sent, so nothing upstream changed. */
  | { kind: "refused"; reason: string }
  | { kind: "failed"; reason: string; transport: DaTransportFailure; status?: number };

/**
 * DA's refusal envelope is `error=1&text=…&details=…`, and `details` is the half
 * that carries the actual cause ("Unable to find user", "Package does not
 * exist"). Both halves are joined because `text` alone is usually a generic
 * "Unable to modify user" that tells a reader nothing.
 */
export function envelopeReason(text: string): string {
  const pick = (k: string) =>
    decodeURIComponent((new RegExp(`(?:^|&)${k}=([^&]*)`).exec(text)?.[1] || "").replace(/\+/g, " ")).trim();
  return [pick("text"), pick("details")].filter(Boolean).join(" — ") || "DirectAdmin refused the request.";
}

/** True for DA's own `error=1` refusal envelope. */
export function isErrorEnvelope(text: string): boolean {
  return /(^|&)error=1(&|$)/.test((text ?? "").trim());
}

/** True when DA handed back its HTML login page instead of an API response. */
export function isLoginPage(text: string): boolean {
  return (text ?? "").trim().startsWith("<");
}

/**
 * One request to DirectAdmin as the admin.
 *
 * `form` present → POST urlencoded; absent → GET with `query`. Several DA
 * endpoints use both on the same path, which is why this takes them rather than
 * being split into two functions.
 */
export async function daAdminRequest(
  path: string,
  opts: { query?: Record<string, string>; form?: URLSearchParams } = {},
): Promise<DaAdminResponse> {
  if (!daAdminConfigured()) {
    return { kind: "refused", reason: "DirectAdmin is not configured in this environment" };
  }

  const auth = "Basic " + Buffer.from(`${ADMIN_USER}:${API_KEY}`).toString("base64");
  const qs = opts.query && Object.keys(opts.query).length ? `?${new URLSearchParams(opts.query)}` : "";

  let res: Response;
  try {
    res = await fetch(`${DA_URL}${path}${qs}`, {
      method: opts.form ? "POST" : "GET",
      headers: {
        Authorization: auth,
        ...(opts.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: opts.form ? opts.form.toString() : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    /* A timeout arrives here too (AbortSignal.timeout), and it belongs here:
       whether DA was slow or unplugged, the request did not land. */
    console.error(`[directadmin:admin] ${path} unreachable: ${(err as Error).message}`);
    return { kind: "failed", reason: "Could not reach DirectAdmin.", transport: "network" };
  }

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    console.error(`[directadmin:admin] ${path} HTTP ${res.status}: ${text.slice(0, 160)}`);
    return {
      kind: "failed",
      reason: `DirectAdmin returned HTTP ${res.status}.`,
      transport: "http",
      status: res.status,
    };
  }

  if (isLoginPage(text)) {
    console.error(`[directadmin:admin] ${path} got the login page — IP not allowed, or bad credentials`);
    return {
      kind: "failed",
      reason: "DirectAdmin returned its login page — this server's IP is not on its allowlist, or the API key is wrong.",
      transport: "login_page",
      status: res.status,
    };
  }

  /* HTTP 200 carrying a refusal. DA does this for every ordinary "no", which is
     why reading only the status is how the ported modules used to report success
     on a failed write. */
  if (isErrorEnvelope(text)) {
    const reason = envelopeReason(text);
    console.error(`[directadmin:admin] ${path} refused: ${reason}`);
    return { kind: "failed", reason, transport: "envelope", status: res.status };
  }

  return { kind: "ok", text };
}
