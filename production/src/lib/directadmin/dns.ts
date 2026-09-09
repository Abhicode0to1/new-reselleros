/**
 * DirectAdmin — the DNS zone of a hosting account.
 *
 * Ported from the DMS engine's `lib/directadmin/dns.ts` (193 lines) on 9 Sep
 * 2026. It could not be ported before today: every call needs DA's "Login-As"
 * auth, and this app only gained that with the control-panel link
 * (`user-auth.ts`, extracted from `sso.ts`).
 *
 * ─── WHEN THIS IS THE RIGHT MODULE, AND WHEN resellerclub/dns.ts IS ──────────
 * Whoever holds the zone. A domain registered through ResellerClub with RC's
 * nameservers has its zone at RC → `lib/resellerclub/dns.ts`. A domain pointed at
 * the hosting server has its zone on DirectAdmin → here. The two are not
 * interchangeable and editing the wrong one changes nothing the internet can see,
 * which is a confusing way to fail.
 *
 * ─── DA ANSWERS THIS ENDPOINT IN TWO COMPLETELY DIFFERENT SHAPES ─────────────
 * Numbered urlencoded fields (`name0=…&value0=…&type0=…`) on most versions, and
 * on some a RAW BIND ZONE FILE. DMS carried a fallback parser for the second and
 * it is ported rather than dropped: a reader that only understands one shape
 * returns "no records" against the other, and an empty zone read is how a
 * reconcile deletes live records.
 *
 * ─── DEFECTS FIXED RATHER THAN PORTED ────────────────────────────────────────
 *
 * 1. TTL WAS HARDCODED TO 14400. DMS's `addDNSRecord` took no ttl at all, so
 *    every record it created got four hours whatever the caller intended. It is a
 *    parameter here, with 14400 kept only as the default.
 *
 * 2. MX AND SRV WERE SILENTLY UNSUPPORTED. DMS's signature has no priority
 *    field, so an MX added through it would carry none — and an MX with no
 *    priority is a mail outage. Rather than send a guess, this REFUSES MX and
 *    SRV with a reason that says why: DA's parameter shape for them varies by
 *    version and there is no DirectAdmin server here to verify it against. That
 *    is the same call `resellerclub/dns.ts` makes about inventing an SRV's
 *    weight and port — a record that resolves and points at the wrong place is
 *    worse than a refusal.
 *
 * 3. THE ERROR CHECK COULD THROW. `response.data.startsWith("error=1")` assumes a
 *    string; DA sometimes answers with an object, and `.startsWith` on it is a
 *    TypeError inside the very branch meant to handle failure. `user-auth.ts`
 *    detects DA's `error=1` envelope once, for every caller.
 *
 * 4. DELETE BUILT ITS SELECTORS UNENCODED — `name=${name}&value=${value}` — so a
 *    record whose value contains `&` or `=` (a TXT record, routinely) produced a
 *    selector for a different record, or for none. Encoded here.
 *
 * NOT PORTED: `updateDNSNameservers`, because DMS's own version throws
 * ("Automatic DNS syncing is disabled. DNS authority is determined at purchase
 * time."). Porting a function whose body is a refusal would only make it look
 * available.
 */
import "server-only";
import { parseDA } from "./index";
import { daUserRequest } from "./user-auth";

export const DA_DNS_TYPES = ["A", "AAAA", "CNAME", "TXT", "NS"] as const;
export type DaDnsType = (typeof DA_DNS_TYPES)[number];

/** DA's own default when none is given. */
export const DA_DEFAULT_TTL = 14400;

export interface DaDnsRecord {
  type: string;
  /** As DA reports it — often the FQDN with a trailing dot, sometimes "@". */
  name: string;
  value: string;
  ttl: number | null;
  /**
   * DA's own handle for the record, when it gives one. A delete needs either this
   * or a name+value selector, so it is carried rather than discarded.
   */
  key: string | null;
}

export type DaDnsListOutcome =
  | { kind: "listed"; records: DaDnsRecord[]; shape: "fields" | "zonefile" }
  | { kind: "refused"; reason: string }
  | { kind: "hard_failure"; reason: string };

export type DaDnsWriteOutcome =
  | { kind: "done" }
  | { kind: "refused"; reason: string }
  | { kind: "hard_failure"; reason: string };

/* ── Parsing ────────────────────────────────────────────────────────────────── */

const num = (v: unknown): number | null => {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const str = (v: unknown): string => {
  const s = Array.isArray(v) ? v[0] : v;
  return s === null || s === undefined ? "" : String(s).trim();
};

/**
 * A raw BIND zone file, which some DA versions return instead of fields.
 *
 * `name [ttl] IN type value`. Comments, `$TTL`/`$ORIGIN` directives and blank
 * lines are skipped; the TTL is optional in the format and so is optional here.
 */
export function parseZoneFile(text: string): DaDnsRecord[] {
  const out: DaDnsRecord[] = [];
  for (const line of (text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith(";") || t.startsWith("$")) continue;
    const m = t.match(/^(\S+)\s+(?:(\d+)\s+)?IN\s+(\w+)\s+(.+)$/i);
    if (!m) continue;
    out.push({
      name: m[1],
      ttl: m[2] ? Number(m[2]) : null,
      type: m[3].toUpperCase(),
      value: m[4].trim(),
      /* A zone file gives no per-record handle, so a delete has to fall back to a
         name+value selector. Saying null is how the caller knows that. */
      key: null,
    });
  }
  return out;
}

/** DA's numbered fields: name0/value0/type0/ttl0/key0, name1/… */
export function parseNumberedRecords(data: Record<string, string | string[]>): DaDnsRecord[] {
  const out: DaDnsRecord[] = [];
  for (let i = 0; data[`name${i}`] !== undefined; i++) {
    const name = str(data[`name${i}`]);
    const value = str(data[`value${i}`]);
    if (!name && !value) continue;
    out.push({
      name,
      value,
      type: str(data[`type${i}`]).toUpperCase(),
      ttl: num(data[`ttl${i}`]),
      key: str(data[`key${i}`]) || null,
    });
  }
  return out;
}

/** True when the body looks like a zone file rather than a field list. */
export function looksLikeZoneFile(text: string): boolean {
  const t = (text ?? "").trim();
  return /\$TTL|\$ORIGIN/i.test(t) || /^\S+\s+(\d+\s+)?IN\s+\w+\s+/im.test(t);
}

/**
 * The selector a delete needs, correctly encoded.
 *
 * DMS built this as `name=${name}&value=${value}` with no encoding, so a TXT
 * record — whose value routinely contains `=` and `;` — produced a selector for
 * something else entirely, or for nothing.
 */
export function deleteSelector(record: Pick<DaDnsRecord, "name" | "value" | "key">): string {
  if (record.key) return record.key;
  return new URLSearchParams({ name: record.name, value: record.value }).toString();
}

/* ── Calls ──────────────────────────────────────────────────────────────────── */

/** Every record in the account's zone, whichever shape DA answers in. */
export async function daListDnsRecords(username: string, domain: string): Promise<DaDnsListOutcome> {
  const res = await daUserRequest("/CMD_API_DNS_CONTROL", username, {
    query: { domain: domain.trim().toLowerCase() },
  });
  if (res.kind !== "ok") return res;

  if (looksLikeZoneFile(res.text)) {
    return { kind: "listed", records: parseZoneFile(res.text), shape: "zonefile" };
  }
  const data = parseDA(res.text);
  if (!data) {
    return { kind: "hard_failure", reason: "DirectAdmin returned a zone body that could not be read." };
  }
  return { kind: "listed", records: parseNumberedRecords(data), shape: "fields" };
}

export interface DaDnsRecordInput {
  type: string;
  /** Empty or "@" means the zone apex; DA wants the domain itself there. */
  name?: string;
  value: string;
  ttl?: number;
}

/**
 * What a record needs before anything is sent — see defect 2 on MX and SRV.
 */
export function refuseReason(input: DaDnsRecordInput): string | null {
  const type = (input.type ?? "").toUpperCase();
  if (type === "MX" || type === "SRV") {
    return `${type} records are not supported through DirectAdmin here yet: they need a priority (and SRV a weight and port), DA's parameter shape for them varies by version, and there is no server to verify it against — sending a guess would create a record that resolves and points at the wrong place.`;
  }
  if (!DA_DNS_TYPES.includes(type as DaDnsType)) {
    return `DirectAdmin DNS here supports ${DA_DNS_TYPES.join(", ")} — not ${type || "an empty type"}.`;
  }
  if (!(input.value ?? "").toString().trim()) return "the record has no value";
  return null;
}

export async function daAddDnsRecord(
  username: string,
  domain: string,
  input: DaDnsRecordInput,
): Promise<DaDnsWriteOutcome> {
  const refused = refuseReason(input);
  if (refused) return { kind: "refused", reason: refused };

  const d = domain.trim().toLowerCase();
  const type = input.type.toUpperCase();
  const asked = (input.name ?? "").trim();

  /* DA wants the zone apex as the domain, not "@". An NS record at the apex wants
     the trailing dot — DMS did this too, and it is a real DA requirement rather
     than a stylistic one. */
  let name = asked === "" || asked === "@" ? d : asked;
  if (type === "NS" && (asked === "" || asked === "@")) name = `${d}.`;

  const form = new URLSearchParams({
    domain: d,
    action: "add",
    type,
    name,
    value: input.value.toString().trim(),
    ttl: String(input.ttl && input.ttl > 0 ? Math.floor(input.ttl) : DA_DEFAULT_TTL),
  });

  const res = await daUserRequest("/CMD_API_DNS_CONTROL", username, { form });
  return res.kind === "ok" ? { kind: "done" } : res;
}

/**
 * Delete records. DA takes a batch, so this does too — one request rather than
 * one per record, for the same reason the usage sweep reads everybody at once.
 */
export async function daDeleteDnsRecords(
  username: string,
  domain: string,
  records: Array<Pick<DaDnsRecord, "name" | "value" | "key">>,
): Promise<DaDnsWriteOutcome> {
  if (!records || records.length === 0) {
    /* Not a failure: asking to delete nothing has already succeeded. Returning
       an error here would make an empty reconcile look broken. */
    return { kind: "done" };
  }

  const form = new URLSearchParams({ domain: domain.trim().toLowerCase(), action: "select" });
  records.forEach((r, i) => form.append(`select${i}`, deleteSelector(r)));

  const res = await daUserRequest("/CMD_API_DNS_CONTROL", username, { form });
  return res.kind === "ok" ? { kind: "done" } : res;
}
