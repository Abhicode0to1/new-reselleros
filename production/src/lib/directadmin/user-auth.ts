/**
 * DirectAdmin's "Login-As" transport — acting AS a hosting user, not as admin.
 *
 * ─── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────
 * Two modules need it and it must behave identically in both. `sso.ts` had it
 * inline first; `dns.ts` needs exactly the same thing, and a second copy of an
 * auth mode is how the two drift until one of them is subtly acting as the wrong
 * user. Same reasoning as `resellerclub/call.ts`.
 *
 * ─── THE PIPE IS THE WHOLE POINT ─────────────────────────────────────────────
 * The HTTP Basic username becomes `admin|username`. Without it DirectAdmin runs
 * the command in the KEY OWNER's context — the admin — so a DNS read would
 * return the reseller's own zone and a write would edit it. That is worse than an
 * error, because it succeeds. An admin acting on itself uses plain auth, since
 * `admin|admin` is not a form DA accepts.
 *
 * ─── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * It does not parse. Callers get the raw text, because the endpoints behind this
 * answer in three different shapes — urlencoded, JSON, and a raw BIND zone file —
 * and a transport that guessed which would be wrong a third of the time.
 */
import "server-only";

const DA_URL = (process.env.DIRECTADMIN_URL?.trim() || "").replace(/\/+$/, "");
const ADMIN_USER = process.env.DIRECTADMIN_ADMIN_USER?.trim() || "";
const API_KEY = process.env.DIRECTADMIN_API_KEY?.trim() || "";

export function daUserAuthConfigured(): boolean {
  return DA_URL.length > 0 && ADMIN_USER.length > 0 && API_KEY.length > 0;
}

/**
 * DA usernames are lowercase alphanumeric. Validating before the value reaches a
 * Basic-auth header or a form body keeps a crafted username out of both — and a
 * username with a `|` in it could otherwise change which account is acted on.
 */
export function isDaUsername(v: string | null | undefined): boolean {
  return /^[a-z0-9]{1,32}$/.test((v ?? "").trim());
}

/** `admin|user`, or plain `admin` when the target IS the admin. */
export function loginAsUser(username: string): string {
  const u = username.trim();
  return u === ADMIN_USER ? ADMIN_USER : `${ADMIN_USER}|${u}`;
}

export type DaUserResponse =
  | { kind: "ok"; text: string }
  | { kind: "refused"; reason: string }
  | { kind: "hard_failure"; reason: string };

/**
 * One request to DirectAdmin as `username`.
 *
 * `form` present → POST urlencoded; absent → GET with `query`. DA's DNS endpoint
 * uses both on the same path, which is why this takes them rather than exposing
 * two functions.
 */
export async function daUserRequest(
  path: string,
  username: string,
  opts: { query?: Record<string, string>; form?: URLSearchParams } = {},
): Promise<DaUserResponse> {
  if (!daUserAuthConfigured()) {
    return { kind: "refused", reason: "DirectAdmin is not configured in this environment" };
  }
  if (!isDaUsername(username)) {
    return { kind: "refused", reason: "that is not a DirectAdmin username, so no request was sent" };
  }

  const auth = "Basic " + Buffer.from(`${loginAsUser(username)}:${API_KEY}`).toString("base64");
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
    console.error(`[directadmin:user] ${path} unreachable: ${(err as Error).message}`);
    return { kind: "hard_failure", reason: "Could not reach DirectAdmin." };
  }

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    console.error(`[directadmin:user] ${path} HTTP ${res.status}: ${text.slice(0, 160)}`);
    return { kind: "hard_failure", reason: `DirectAdmin returned HTTP ${res.status}.` };
  }

  /* DA answers a refusal with HTTP 200 and `error=1&text=…&details=…`. Reading
     that as success is the defect this repo has now fixed in three ported
     modules, so it is caught here once rather than at each call site. */
  if (/(^|&)error=1(&|$)/.test(text.trim()) || text.trim().startsWith("<")) {
    const pick = (k: string) =>
      decodeURIComponent((new RegExp(`(?:^|&)${k}=([^&]*)`).exec(text)?.[1] || "").replace(/\+/g, " ")).trim();
    const why = text.trim().startsWith("<")
      ? "DirectAdmin returned its login page — the IP is not allowed, or the credentials are wrong."
      : [pick("text"), pick("details")].filter(Boolean).join(" — ") || "DirectAdmin refused the request.";
    console.error(`[directadmin:user] ${path} refused: ${why}`);
    return { kind: "hard_failure", reason: why };
  }

  return { kind: "ok", text };
}
