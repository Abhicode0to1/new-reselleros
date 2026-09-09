/**
 * DirectAdmin — facts about the SERVER, not about any one account.
 *
 * Ported from the DMS engine's `lib/directadmin/server.ts` on 9 Sep 2026. The
 * smallest of the ports and the least interesting, with one exception worth the
 * file: the licence tells you how many accounts the server may hold, and running
 * out of that allowance fails provisioning with a message about nothing in
 * particular. Knowing the headroom BEFORE a sale is the difference between
 * "we're at our licence limit, buy more seats" and a support ticket.
 *
 * ─── WHY THESE RETURN RAW MAPS ───────────────────────────────────────────────
 * `CMD_API_SYSTEM_INFO` and `CMD_API_LICENSE` answer with dozens of fields whose
 * names differ across DA versions, and there is no DirectAdmin server reachable
 * from here to check any particular spelling against. DMS dumped both maps
 * straight into a diagnostics response and never named a field, which was the
 * right instinct. So these hand back what DA sent, and the one derived thing
 * anybody needs — the licence headroom — is a separate pure function that reads
 * several candidate spellings and returns null when it finds none, rather than
 * reporting a confident zero.
 */
import "server-only";
import { parseDA } from "./index";
import { daAdminRequest, daAdminConfigured } from "./admin-request";
import { classifyDaFailure } from "./classify";

export type DaServerReadOutcome =
  | { kind: "read"; fields: Record<string, string | string[]> }
  | { kind: "refused"; reason: string }
  | { kind: "unreachable"; reason: string }
  | { kind: "not_authorised"; reason: string }
  | { kind: "hard_failure"; reason: string };

async function serverRead(op: string, path: string): Promise<DaServerReadOutcome> {
  if (!daAdminConfigured()) {
    return { kind: "refused", reason: "DirectAdmin is not configured in this environment" };
  }
  const res = await daAdminRequest(path);
  if (res.kind === "refused") return res;
  if (res.kind === "failed") {
    /* No `consider` list: nothing server-scoped can be "user not found", so any
       recognised-sounding wording here would be a coincidence. */
    const v = classifyDaFailure(op, res, []);
    if (v.kind === "unreachable") return { kind: "unreachable", reason: v.reason };
    if (v.kind === "not_authorised") return { kind: "not_authorised", reason: v.reason };
    return { kind: "hard_failure", reason: v.reason };
  }
  const fields = parseDA(res.text);
  if (!fields) return { kind: "hard_failure", reason: `DirectAdmin returned a ${op} body that could not be read.` };
  return { kind: "read", fields };
}

/** Software versions and system facts — DA's PHP default, kernel, and so on. */
export async function daServerInfo(): Promise<DaServerReadOutcome> {
  return serverRead("systemInfo", "/CMD_API_SYSTEM_INFO");
}

/** The DirectAdmin licence: seats, expiry, and whatever else this version sends. */
export async function daLicense(): Promise<DaServerReadOutcome> {
  return serverRead("license", "/CMD_API_LICENSE");
}

export type DaResellerListOutcome =
  | { kind: "listed"; resellers: string[] }
  | { kind: "refused"; reason: string }
  | { kind: "unreachable"; reason: string }
  | { kind: "not_authorised"; reason: string }
  | { kind: "hard_failure"; reason: string };

/**
 * Resellers on the server.
 *
 * As everywhere else in this port, `listed: []` means DA answered and there are
 * none — a failed read says so instead, rather than presenting as an empty
 * server.
 */
export async function daListResellers(): Promise<DaResellerListOutcome> {
  const out = await serverRead("listResellers", "/CMD_API_SHOW_RESELLERS");
  if (out.kind !== "read") return out;
  const raw = out.fields["list[]"] ?? out.fields["list"] ?? [];
  const resellers = (Array.isArray(raw) ? raw : [raw]).map((s) => (s ?? "").trim()).filter(Boolean);
  return { kind: "listed", resellers };
}

export interface DaLicenceHeadroom {
  /** Accounts in use, when DA said. */
  used: number | null;
  /** The seat cap. -1 for an unlimited licence. Null when DA did not say. */
  max: number | null;
  /**
   * Seats left, or null when either half is unknown or the licence is
   * unlimited. Null means "cannot tell" — never treat it as zero.
   */
  remaining: number | null;
}

/**
 * How much room the licence has left.
 *
 * The candidate key spellings are exactly that — candidates. DA's field names
 * for this vary by version and none of them could be verified against a live
 * server from here, so an unmatched map yields nulls rather than a confident
 * number. A caller must show "unknown", not "0 seats left": a false zero would
 * block sales the server can perfectly well handle.
 */
export function licenceHeadroom(fields: Record<string, string | string[]>): DaLicenceHeadroom {
  const num = (keys: string[]): number | null => {
    for (const k of keys) {
      const v = Array.isArray(fields[k]) ? (fields[k] as string[])[0] : (fields[k] as string | undefined);
      const s = (v ?? "").trim();
      if (s === "") continue;
      if (/unlimited/i.test(s)) return -1;
      const n = Number(s);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };

  const used = num(["users", "num_users", "user_count", "accounts"]);
  const max = num(["max_users", "maxusers", "users_max", "max_accounts"]);
  const remaining = max === null || used === null || max < 0 ? null : Math.max(0, max - used);
  return { used, max, remaining };
}
