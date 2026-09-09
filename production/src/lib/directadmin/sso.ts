/**
 * DirectAdmin one-time login — "open this customer's control panel".
 *
 * Ported from the DMS engine's `getOneTimeLoginUrl` (lib/directadmin/users.ts) on
 * 9 Sep 2026. It lives in its own file rather than beside the read helpers
 * because what it returns IS a credential, and that deserves to be obvious to
 * whoever opens the file next.
 *
 * ─── THE URL IS THE SECRET ───────────────────────────────────────────────────
 * Anyone holding it is inside the customer's hosting panel until it is used or
 * expires. So:
 *   · it is NEVER logged, at any level, on success or failure — DMS logs only the
 *     username and this keeps that discipline;
 *   · it is never persisted, not even to record that it was issued. The audit row
 *     the caller writes says WHO asked for WHICH account, and no more;
 *   · the caller is expected to hand it straight to the browser and forget it.
 *
 * ─── DA'S "LOGIN-AS" AUTH ────────────────────────────────────────────────────
 * The HTTP Basic username becomes `admin|username`, or the session lands in the
 * KEY OWNER's context and the link opens the reseller's own panel instead of the
 * customer's. That transport started here and now lives in `user-auth.ts`,
 * because `dns.ts` needs the identical thing — see that file's header.
 *
 * ─── THE DENY LIST IS NOT DECORATION ─────────────────────────────────────────
 * The session is created with a set of commands explicitly denied, and the
 * choice is DMS's, kept because it is well judged: no password change, no
 * minting of further login keys, no contact-detail change and no touching 2FA.
 * The point is that a support session cannot be turned into permanent access —
 * if it could, "let me take a look for you" would silently become an account
 * takeover, and the customer would have no way to tell.
 *
 * ─── FIVE MINUTES, NOT AN HOUR ───────────────────────────────────────────────
 * DMS set `expiry_timestamp` an hour out. The flow is a button that opens the
 * panel immediately, so an hour is 55 minutes of a live credential sitting in
 * whatever copied it. Five is ample for a blocked popup and a retry.
 */
import "server-only";
import { parseDA } from "./index";
import { daUserRequest, daUserAuthConfigured, isDaUsername } from "./user-auth";

/** Same three-part check the rest of the module uses. */
export function daSsoConfigured(): boolean {
  return daUserAuthConfigured();
}

export const SSO_TTL_SECONDS = 5 * 60;

/** Commands the borrowed session must not be able to run — see the header. */
export const SSO_DENIED_COMMANDS = [
  "CMD_USER_PASSWD",
  "CMD_LOGIN_KEYS",
  "CMD_API_LOGIN_KEYS",
  "CMD_CHANGE_INFO",
  "CMD_TWO_FACTOR_AUTH",
] as const;

export type DaSsoOutcome =
  | { kind: "ready"; url: string; expiresInSeconds: number }
  /** Our own precondition failed; nothing was sent. */
  | { kind: "refused"; reason: string }
  | { kind: "hard_failure"; reason: string };

/**
 * The form body DA wants, built separately so it can be asserted in a test
 * without a server. The deny list and the single use are the security-relevant
 * parts, and a test that pins them is cheaper than noticing later that a refactor
 * dropped one.
 */
export function ssoRequestBody(username: string, redirect: string, now = new Date()): URLSearchParams {
  const body = new URLSearchParams({
    action: "create",
    type: "one_time_url",
    user: username,
    "redirect-url": redirect,
    /* The customer should not get an email because a colleague opened their
       panel to help them. */
    notify: "no",
    allow_html: "yes",
    max_uses: "1",
    clear_key: "yes",
    expiry_timestamp: String(Math.floor(now.getTime() / 1000) + SSO_TTL_SECONDS),
  });
  SSO_DENIED_COMMANDS.forEach((cmd, i) => body.set(`select_deny${i}`, cmd));
  return body;
}

/**
 * DA answers this endpoint with a bare URL, or with a JSON/urlencoded envelope
 * carrying one. Both shapes appear in the wild depending on version, so the
 * extraction is separate and tested rather than a chain of `if`s at the call
 * site — and anything that is not an http(s) URL is refused rather than passed
 * on as if it were a link.
 */
export function extractSsoUrl(text: string): string | null {
  const raw = (text ?? "").trim();
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw.split(/\s/)[0];

  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ["result", "url", "link"]) {
      const v = json[key];
      if (typeof v === "string" && /^https?:\/\//.test(v.trim())) return v.trim();
    }
  } catch {
    /* not JSON — fall through to DA's urlencoded form */
  }

  const parsed = parseDA(raw);
  for (const key of ["result", "url", "link"]) {
    const v = parsed?.[key];
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === "string" && /^https?:\/\//.test(s.trim())) return s.trim();
  }
  return null;
}

/**
 * A one-time URL into `username`'s control panel.
 *
 * `redirect` is the DA command the session lands on. The default is the stats
 * page rather than the file manager or DNS editor: a support session should open
 * somewhere harmless and let the person navigate deliberately.
 */
export async function daOneTimeLoginUrl(
  username: string,
  redirect = "CMD_USER_STATS",
): Promise<DaSsoOutcome> {
  if (!daSsoConfigured()) {
    return { kind: "refused", reason: "DirectAdmin is not configured in this environment" };
  }
  const user = (username ?? "").trim();
  if (!isDaUsername(user)) {
    return { kind: "refused", reason: "that is not a DirectAdmin username, so no login was requested" };
  }

  /* The Login-As auth, the error=1 envelope and the HTML-login-page case all live
     in user-auth.ts now — extracted when dns.ts needed exactly the same thing,
     because a second copy of an auth mode is how the two drift until one is
     acting as the wrong user. */
  const res = await daUserRequest("/CMD_API_LOGIN_KEYS", user, { form: ssoRequestBody(user, redirect) });
  if (res.kind !== "ok") return res;

  const url = extractSsoUrl(res.text);
  if (!url) {
    /* Deliberately does NOT log the body: on a 200 the body may BE the URL in a
       shape this function failed to recognise, and logging it would write the
       credential to disk. */
    console.error(`[directadmin:sso] ${user}: no usable URL in a 200 response (${res.text.length} bytes)`);
    return { kind: "hard_failure", reason: "DirectAdmin accepted the request but returned no usable login link." };
  }

  return { kind: "ready", url, expiresInSeconds: SSO_TTL_SECONDS };
}
