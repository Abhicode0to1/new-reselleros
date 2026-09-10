/**
 * DirectAdmin — reading hosting accounts. What exists on the server, and whose.
 *
 * Ported from the DMS engine's `lib/directadmin/users.ts` (getUserConfig,
 * getUserDomains, listUsers, domainExists) on 9 Sep 2026, with its typed-outcome
 * wrapper from `lib/integrations/directadmin/get-user-config.ts` folded in — DMS
 * had two layers because the inner one threw on every failure and every caller
 * had to guess what the throw meant. One layer, typed from the start.
 *
 * READ-ONLY. Writes live in `provision.ts`; that boundary is the only reason a
 * reader can trust that opening this file cannot change a customer's account.
 *
 * ─── AN EMPTY LIST AND A FAILED READ ARE DIFFERENT ANSWERS ───────────────────
 * DMS returned bare arrays here, so "this account has no domains" and "the read
 * failed" arrived as the same `[]`. Anything reconciling against that deletes
 * whatever it cannot currently see — the same failure `resellerclub/dns.ts` and
 * `dns-sync.ts` are both built around. Every list here reports which one it is.
 *
 * ─── DEFECTS FIXED RATHER THAN PORTED ────────────────────────────────────────
 *
 * 1. `domainExists` RETURNED FALSE WHEN THE CHECK ITSELF FAILED. Its own comment
 *    said so: "If checking fails, assume false … to allow purchase attempt".
 *    False means "nothing here, go ahead and create it", so a DA blip could send
 *    a provisioning run at a domain that is already hosted by someone else. It is
 *    three-state now — `owned` / `unowned` / `unknown` — and a caller that treats
 *    `unknown` as free is doing so visibly.
 *
 * 2. `suspended` WAS HANDED BACK AS THE STRING DA SENT. DA answers `yes` or
 *    `no`, and `no` is a truthy string: any caller writing `if (config.suspended)`
 *    reads every healthy account as suspended. It is a real boolean here.
 *
 * 3. `getUserConfig` RETURNED AN UNTYPED BAG of `Record<string, string>`, so
 *    every call site indexed it with a magic string and a typo read as absent.
 *    Parsed into a named shape, with the raw map still available for the fields
 *    nothing has needed yet.
 *
 * 4. `validateUsername` LOWERCASED ONLY FOR ITS OWN REGEX — `/^[a-z]/.test(
 *    username.toLowerCase())` — then sent the original, so `ACME1` passed
 *    validation and went to DA unchanged. `isDaUsername` requires lowercase and
 *    the value sent is the value checked.
 *
 * 5. `getUserDomains`'s LAST-RESORT FALLBACK took every response key containing
 *    a dot as a domain, having excluded only `error`/`text`/`details`. DA's
 *    config-shaped responses carry keys like `date_created` — no dot, fine — but
 *    also version and quota fields that do, so the fallback could invent domains
 *    out of metadata. It is kept, because some DA versions really do answer with
 *    domains as keys, but it now requires something that looks like a hostname.
 */
import "server-only";
import { parseDA } from "./index";
import { isDaUsername } from "./user-auth";
import { daAdminRequest, daAdminConfigured } from "./admin-request";
import { classifyDaFailure, type DaFailureKind } from "./classify";

export { daAdminConfigured };

/* ── Shared failure shape ────────────────────────────────────────────────────
 * Every function here reports the same set of failures under the same names, so
 * a caller handling one has already learnt how to handle the rest.
 */
export type DaReadFailure =
  /** Our own precondition; nothing was sent. */
  | { kind: "refused"; reason: string }
  /** DA is down or unreachable. Retry later; change nothing now. */
  | { kind: "unreachable"; reason: string }
  /** Wrong key, or this server's IP is not on DA's allowlist. Not per-account. */
  | { kind: "not_authorised"; reason: string }
  | { kind: "hard_failure"; reason: string };

/** Map a classifier verdict onto the failure shape above. */
function toReadFailure(op: string, fail: { reason: string; transport: "network" | "http" | "envelope" | "login_page"; status?: number }, consider: readonly DaFailureKind[] = []): DaReadFailure | { kind: "user_not_found"; reason: string } {
  const v = classifyDaFailure(op, fail, consider);
  switch (v.kind) {
    case "unreachable":
      return { kind: "unreachable", reason: v.reason };
    case "not_authorised":
      return { kind: "not_authorised", reason: v.reason };
    case "user_not_found":
      return { kind: "user_not_found", reason: v.reason };
    default:
      return { kind: "hard_failure", reason: v.reason };
  }
}

/* ── One account's configuration ─────────────────────────────────────────────── */

export interface DaUserConfig {
  username: string;
  email: string | null;
  /** The package name — the thing that actually carries the account's limits. */
  package: string | null;
  /** The account's primary domain, as DA records it. */
  domain: string | null;
  ip: string | null;
  /** DA sends `yes`/`no`; see defect 2. Null when DA did not say at all. */
  suspended: boolean | null;
  /** Whoever created the account — `admin`, or a reseller's username. */
  creator: string | null;
  /** DA's own creation date string, unparsed: its format varies by version. */
  dateCreated: string | null;
  /** Everything DA sent, for fields nothing has needed to name yet. */
  raw: Record<string, string | string[]>;
}

const one = (v: string | string[] | undefined): string | null => {
  const s = Array.isArray(v) ? v[0] : v;
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};

/**
 * DA's yes/no fields. Anything it does not recognise stays null rather than
 * becoming false: "DA did not tell us" and "DA said not suspended" are different,
 * and only one of them is safe to act on.
 */
export function parseDaBool(v: string | string[] | undefined): boolean | null {
  const s = one(v)?.toLowerCase();
  if (s === "yes" || s === "on" || s === "true" || s === "1") return true;
  if (s === "no" || s === "off" || s === "false" || s === "0") return false;
  return null;
}

export function parseUserConfig(username: string, data: Record<string, string | string[]>): DaUserConfig {
  return {
    username: one(data.username) ?? username,
    email: one(data.email),
    package: one(data.package),
    domain: one(data.domain),
    ip: one(data.ip),
    suspended: parseDaBool(data.suspended),
    creator: one(data.creator),
    dateCreated: one(data.date_created),
    raw: data,
  };
}

export type DaUserConfigOutcome =
  | { kind: "found"; config: DaUserConfig }
  /** DA is up and says there is no such account. The local row is stale. */
  | { kind: "user_not_found"; reason: string }
  | DaReadFailure;

/** One account's configuration, or a reason that says what to do about it. */
export async function daUserConfig(username: string): Promise<DaUserConfigOutcome> {
  if (!daAdminConfigured()) {
    return { kind: "refused", reason: "DirectAdmin is not configured in this environment" };
  }
  if (!isDaUsername(username)) {
    return { kind: "refused", reason: "that is not a DirectAdmin username, so no request was sent" };
  }

  const res = await daAdminRequest("/CMD_API_SHOW_USER_CONFIG", { query: { user: username } });
  if (res.kind === "refused") return res;
  if (res.kind === "failed") return toReadFailure("getUserConfig", res, ["user_not_found"]);

  const data = parseDA(res.text);
  if (!data || Object.keys(data).length === 0) {
    /* A 200 with nothing in it. DA does this for some missing users instead of
       the error envelope, so an empty body IS the not-found signal here — but it
       is reported as its own thing rather than as an account with every field
       null, which would look real to anything downstream. */
    return { kind: "user_not_found", reason: "DirectAdmin returned no configuration for that account." };
  }
  return { kind: "found", config: parseUserConfig(username, data) };
}

/* ── Lists ───────────────────────────────────────────────────────────────────── */

/** Loose hostname test for the key-based fallback — see defect 5. */
export function looksLikeHostname(v: string): boolean {
  /* A label may not START OR END with a hyphen (RFC 1123). This first guarded
     only the start, so "acme-.com" passed — same slip as lib/domains/watch.ts,
     found there by a test and fixed in both on 10 Sep 2026. */
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(v.trim());
}

/**
 * DA's list responses come back as `list[]=a&list[]=b`, sometimes as `list=a`,
 * and on some endpoints/versions as the values being the KEYS. All three are
 * read, because a reader that knows one shape reports an empty list against the
 * others — and an empty list is the answer that does damage.
 */
export function parseDaList(data: Record<string, string | string[]>, opts: { hostnames?: boolean } = {}): string[] {
  const raw = data["list[]"] ?? data["list"] ?? [];
  const listed = (Array.isArray(raw) ? raw : [raw]).map((s) => (s ?? "").trim()).filter(Boolean);
  if (listed.length > 0) return listed;

  /* Fallback: the values are the keys. DMS took any key containing a dot, which
     could turn a version string into a domain; a hostname shape is required when
     the caller says these should be hostnames. */
  const meta = new Set(["error", "text", "details", "list", "list[]"]);
  return Object.keys(data)
    .filter((k) => !meta.has(k))
    .filter((k) => (opts.hostnames ? looksLikeHostname(k) : true))
    .map((k) => k.trim())
    .filter(Boolean);
}

export type DaListOutcome =
  | { kind: "listed"; items: string[] }
  | { kind: "user_not_found"; reason: string }
  | DaReadFailure;

/**
 * Every domain on one account.
 *
 * `{ kind: "listed", items: [] }` means DA answered and the account genuinely has
 * no domains. A failed read is never that — see the header.
 */
export async function daUserDomains(username: string): Promise<DaListOutcome> {
  if (!daAdminConfigured()) {
    return { kind: "refused", reason: "DirectAdmin is not configured in this environment" };
  }
  if (!isDaUsername(username)) {
    return { kind: "refused", reason: "that is not a DirectAdmin username, so no request was sent" };
  }

  const res = await daAdminRequest("/CMD_API_SHOW_USER_DOMAINS", { query: { user: username } });
  if (res.kind === "refused") return res;
  if (res.kind === "failed") return toReadFailure("getUserDomains", res, ["user_not_found"]);

  const data = parseDA(res.text);
  if (!data) return { kind: "hard_failure", reason: "DirectAdmin returned a domain list that could not be read." };
  return { kind: "listed", items: parseDaList(data, { hostnames: true }) };
}

/**
 * Every account on the server.
 *
 * The expensive-looking call that is actually the cheap one: DMS's admin screens
 * fanned out a per-user config request for each name this returns, and the
 * 45-second page load its own comment complains about is that fan-out. Where the
 * question is "which accounts exist", this one request answers it.
 */
export async function daListUsers(): Promise<DaListOutcome> {
  if (!daAdminConfigured()) {
    return { kind: "refused", reason: "DirectAdmin is not configured in this environment" };
  }

  const res = await daAdminRequest("/CMD_API_SHOW_USERS");
  if (res.kind === "refused") return res;
  if (res.kind === "failed") return toReadFailure("listUsers", res);

  const data = parseDA(res.text);
  if (!data) return { kind: "hard_failure", reason: "DirectAdmin returned a user list that could not be read." };
  /* Not hostnames — these are usernames, so the shape filter would drop them. */
  return { kind: "listed", items: parseDaList(data) };
}

/* ── Who owns a domain ───────────────────────────────────────────────────────── */

export type DaDomainOwnerOutcome =
  /** DA says this domain is on the server, held by `username`. */
  | { kind: "owned"; username: string }
  /** DA answered, and the domain is not on the server. Safe to provision. */
  | { kind: "unowned" }
  /**
   * DA could not tell us. NOT the same as `unowned` — see defect 1. A caller
   * that provisions on this is choosing to risk a collision, and has to say so.
   */
  | { kind: "unknown"; reason: string };

/**
 * Read the owner out of `CMD_API_DOMAIN_OWNERS`. DA answers `domain=username`,
 * so the domain is the key; some versions wrap it in a list instead.
 */
export function ownerFrom(domain: string, data: Record<string, string | string[]>): string | null {
  const d = domain.trim().toLowerCase();
  const direct = one(data[d]);
  if (direct) return direct;
  /* Some versions answer `list[]=domain.com=username`. */
  const raw = data["list[]"] ?? data["list"] ?? [];
  for (const entry of Array.isArray(raw) ? raw : [raw]) {
    const [k, v] = (entry ?? "").split("=");
    if ((k ?? "").trim().toLowerCase() === d && (v ?? "").trim()) return v.trim();
  }
  return null;
}

/**
 * Who holds `domain` on the DirectAdmin server, if anyone.
 *
 * DA answers a domain it does not have with its `error=1` envelope, so the
 * refusal here IS the "not on this server" answer — but only when DA answered.
 * A network failure or a login page means we do not know, and this says so
 * rather than reporting the domain free.
 */
export async function daDomainOwner(domain: string): Promise<DaDomainOwnerOutcome> {
  const d = (domain ?? "").trim().toLowerCase();
  if (!looksLikeHostname(d)) {
    return { kind: "unknown", reason: "that is not a domain name, so nothing was checked" };
  }
  if (!daAdminConfigured()) {
    return { kind: "unknown", reason: "DirectAdmin is not configured in this environment" };
  }

  const res = await daAdminRequest("/CMD_API_DOMAIN_OWNERS", { query: { domain: d } });

  if (res.kind === "refused") return { kind: "unknown", reason: res.reason };
  if (res.kind === "failed") {
    /* DA refusing in its envelope is the real "no such domain" — it understood
       the question. Anything else means we never got an answer. */
    return res.transport === "envelope"
      ? { kind: "unowned" }
      : { kind: "unknown", reason: res.reason };
  }

  const data = parseDA(res.text);
  if (!data) return { kind: "unknown", reason: "DirectAdmin returned an owner response that could not be read." };

  const owner = ownerFrom(d, data);
  return owner ? { kind: "owned", username: owner } : { kind: "unowned" };
}
