/**
 * ResellerClub — DNS zone management.
 *
 * Ported from the DMS engine's `lib/resellerclub/dns.ts` (418 lines) on 9 Sep 2026
 * onto this repo's `rcCall` spine. Three of its eight functions are NOT ported,
 * because this repo already had them and a second copy would drift:
 *
 *   · `setCustomNameservers`  -> use `rcModifyNameservers` in ./orders. Ours also
 *     refuses fewer than two nameservers, which DMS's did not — one nameserver is
 *     an outage waiting for the first reboot.
 *   · `getNameservers`        -> `rcDomainDetails(name).nameservers` in ./orders.
 *   · `setDefaultNameservers` -> DMS's own comment says RC has no such endpoint;
 *     it is `rcModifyNameservers` pointed at the reseller defaults, which
 *     `defaultNameservers()` in ./orders already knows.
 *
 * ─── THE SHAPE RC IMPOSES, WHICH THIS FILE ABSORBS ───────────────────────────
 * There is no "add record" endpoint. There is one endpoint PER RECORD TYPE
 * (`add-ipv4-record`, `add-cname-record`, …), each with its own required params,
 * and a single `modify-record` / `delete-record` pair for changes. Reads are
 * worse: `search-records` takes ONE type per call, so listing a zone is seven
 * calls. Callers should not have to know any of that.
 *
 * ─── DEFECTS FIXED RATHER THAN PORTED ────────────────────────────────────────
 *
 * 1. AN EMPTY ZONE AND A FAILED READ LOOKED IDENTICAL. DMS wrapped each per-type
 *    call in `catch (typeError) { serverLogger.info("No ${type} records found") }`
 *    and then returned `status:"success"` with whatever it had. So an auth error,
 *    a timeout or RC's IP-whitelist rejection produced "this domain has no DNS
 *    records" — for a live domain. That is dangerous in both directions: a
 *    customer told their zone is empty may re-add records that already exist, and
 *    any reconcile built on top of this read would delete the real ones. This
 *    module reports `partial` with the types that failed and WHY, and never
 *    presents an incomplete read as a complete one.
 *
 * 2. HTTP 200 WITH AN IN-BODY ERROR WAS A SUCCESS. Every write returned
 *    `status:"success"` on any 2xx without reading RC's `{"status":"ERROR"}`, so a
 *    refused add was reported as added. `rcCall` normalises that for all of them —
 *    the same defect the handoff already caught in DMS's renew/transfer path.
 *
 * 3. SRV RECORDS GOT weight=10 AND port=443, HARDCODED. An SRV record IS its
 *    priority/weight/port triple; inventing two thirds of it produces a record
 *    that resolves and points at the wrong place, which is harder to spot than a
 *    refusal. Both are required here.
 *
 * 4. AN MX WITH NO PRIORITY DEFAULTED TO 10. `dns_records` has a CHECK constraint
 *    (`dns_records_priority_required`) that refuses exactly that, because a null
 *    MX priority is a mail outage. Defaulting upstream of a constraint that
 *    forbids it puts RC and our own table into disagreement, so this refuses too.
 */
import "server-only";
import { rcCall, rcOrderingEnabled } from "./call";
import { matchesAny, READ_NOT_FOUND_FRAGMENTS } from "./classify";

/**
 * RC's DNS wording for "there is nothing here", which is NOT the order side's.
 *
 * `READ_NOT_FOUND_FRAGMENTS` in classify.ts covers order reads — "no orders found",
 * "no entity found". A DNS search answers "No records found" and a delete answers
 * "No such record found", and neither contains any fragment on that list, so the
 * shared list alone reads an empty zone as a hard failure. Measured 9 Sep 2026 by
 * three failing tests, not guessed.
 *
 * Kept local rather than added to the shared list on purpose: that list decides
 * whether an ORDER exists, and widening it with DNS phrasing would change how a
 * registration lookup behaves to fix a DNS read. Both lists are consulted below.
 */
const DNS_ABSENT_FRAGMENTS = [
  "no records found",
  "no record found",
  "no records",
  "no such record",
  "no dns record",
  "zone does not exist",
  "no zone",
] as const;

/** Either vocabulary means absence. */
function meansAbsent(message: string | undefined): boolean {
  return matchesAny(message, DNS_ABSENT_FRAGMENTS) || matchesAny(message, READ_NOT_FOUND_FRAGMENTS);
}

/** The types RC exposes a per-type endpoint for. */
export const RC_DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SRV"] as const;
export type RcDnsRecordType = (typeof RC_DNS_TYPES)[number];

/**
 * RC's minimum TTL. Sending less is rejected, so it is clamped rather than
 * refused — but `ttlUsed` says what actually went, because a caller that asked
 * for 300 and silently got 7200 will otherwise believe its own number.
 */
export const RC_MIN_TTL = 7200;

/** Field names are ours; the mapping from RC's (`recordid`, `timetolive`) is here. */
export interface RcDnsRecord {
  /** RC's `recordid` — the handle a modify/delete needs. `dns_records.provider_record_id`. */
  providerRecordId: string | null;
  type: RcDnsRecordType;
  host: string;
  value: string;
  ttl: number;
  priority: number | null;
}

export interface RcDnsRecordInput {
  type: RcDnsRecordType;
  /** "@" for the apex; normalised to the domain name for RC. */
  host: string;
  value: string;
  ttl?: number;
  /** Required for MX and SRV. */
  priority?: number;
  /** Required for SRV, and only SRV. */
  weight?: number;
  port?: number;
}

export type RcDnsListOutcome =
  | { kind: "listed"; records: RcDnsRecord[] }
  /** Some types answered and some did not. The records are real; the LIST is not complete. */
  | { kind: "partial"; records: RcDnsRecord[]; failed: Array<{ type: RcDnsRecordType; reason: string }> }
  /** RC says there is no zone here — DNS management not active, or no such domain. */
  | { kind: "not_found"; reason: string }
  | { kind: "hard_failure"; reason: string };

export type RcDnsWriteOutcome =
  | { kind: "done"; providerRecordId: string | null; ttlUsed?: number }
  /** Our own precondition failed. Nothing was sent, so an unchanged retry cannot help. */
  | { kind: "refused"; reason: string }
  | { kind: "hard_failure"; reason: string };

/* ── Helpers ────────────────────────────────────────────────────────────────── */

/** RC wants the FQDN in `host`, so the apex is the domain itself, not "@". */
function hostFor(host: string, domainName: string): string {
  const h = (host || "").trim();
  return h === "" || h === "@" ? domainName : h;
}

function clampTtl(ttl: number | undefined): number {
  const n = Number(ttl);
  if (!Number.isFinite(n) || n <= 0) return RC_MIN_TTL;
  return Math.max(Math.floor(n), RC_MIN_TTL);
}

/** The add endpoint for each type. RC has no single one. */
const ADD_ENDPOINT: Record<RcDnsRecordType, string> = {
  A: "/api/dns/manage/add-ipv4-record.json",
  AAAA: "/api/dns/manage/add-ipv6-record.json",
  CNAME: "/api/dns/manage/add-cname-record.json",
  MX: "/api/dns/manage/add-mx-record.json",
  NS: "/api/dns/manage/add-ns-record.json",
  TXT: "/api/dns/manage/add-txt-record.json",
  SRV: "/api/dns/manage/add-srv-record.json",
};

/**
 * What a record needs beyond host/value/ttl, refused rather than defaulted.
 *
 * See defects 3 and 4: the defaults DMS used produce a record that looks fine and
 * behaves wrongly, and for MX the default also contradicts a CHECK constraint on
 * our own table.
 */
function missingForType(input: RcDnsRecordInput): string[] {
  const missing: string[] = [];
  if (!input.value?.toString().trim()) missing.push("value");
  if (input.type === "MX" && !Number.isFinite(Number(input.priority))) {
    missing.push("priority (an MX with no priority is a mail outage — dns_records refuses it too)");
  }
  if (input.type === "SRV") {
    if (!Number.isFinite(Number(input.priority))) missing.push("priority");
    if (!Number.isFinite(Number(input.weight))) missing.push("weight");
    if (!Number.isFinite(Number(input.port))) missing.push("port");
  }
  return missing;
}

/** RC returns a numbered map plus two count keys. Pull the records out of it. */
function recordsFrom(data: Record<string, unknown>, type: RcDnsRecordType): RcDnsRecord[] {
  const out: RcDnsRecord[] = [];
  for (const [key, raw] of Object.entries(data)) {
    if (key === "recsonpage" || key === "recsindb") continue;
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const value = str(r["value"]);
    const host = str(r["host"] ?? r["name"]);
    if (!value && !host) continue;
    out.push({
      providerRecordId: str(r["recordid"] ?? r["recordId"] ?? r["record-id"] ?? key) || null,
      type: (str(r["type"]).toUpperCase() as RcDnsRecordType) || type,
      host,
      value,
      ttl: num(r["timetolive"] ?? r["ttl"]) ?? RC_MIN_TTL,
      priority: num(r["priority"]),
    });
  }
  return out;
}

/* ── Activate ───────────────────────────────────────────────────────────────── */

/**
 * Turn RC's DNS service on for a domain. Records cannot be written until this
 * has happened, and it is idempotent — RC answers with an error naming the
 * already-active state, which reads as `done` rather than a failure.
 */
export async function rcActivateDnsManagement(domainName: string, orderId: string): Promise<RcDnsWriteOutcome> {
  if (!rcOrderingEnabled()) {
    return { kind: "refused", reason: "domain changes are switched off in this environment (DOMAIN_REGISTER_LIVE is not 1)" };
  }
  const res = await rcCall(
    "/api/dns/activate.json",
    { "domain-name": domainName.trim().toLowerCase(), "order-id": orderId.trim() },
    "POST",
    { allowScalar: true },
  );
  if (res.status === "success") return { kind: "done", providerRecordId: null };
  if (matchesAny(res.message, ["already active", "already activated", "dns is active"])) {
    return { kind: "done", providerRecordId: null };
  }
  return { kind: "hard_failure", reason: res.message || "ResellerClub refused to activate DNS management" };
}

/* ── Read ───────────────────────────────────────────────────────────────────── */

/**
 * Every record in the zone, across all seven types.
 *
 * One call per type, because that is RC's API. The result says plainly whether
 * the list is complete: see defect 1 — an incomplete read presented as a complete
 * one is how a reconcile deletes live records.
 */
export async function rcListDnsRecords(domainName: string, customerId: string): Promise<RcDnsListOutcome> {
  const domain = domainName.trim().toLowerCase();
  const records: RcDnsRecord[] = [];
  const failed: Array<{ type: RcDnsRecordType; reason: string }> = [];
  let sawNotFound = 0;

  for (const type of RC_DNS_TYPES) {
    const res = await rcCall(
      "/api/dns/manage/search-records.json",
      {
        "domain-name": domain,
        "customer-id": customerId.trim(),
        type,
        "no-of-records": "50",
        "page-no": "1",
      },
      "GET",
    );

    if (res.status === "success" && res.data) {
      records.push(...recordsFrom(res.data, type));
      continue;
    }
    /* "no records of this type" is a legitimate empty answer, not a failure. It is
       the ONLY error shape allowed to be read as an absence. */
    if (meansAbsent(res.message)) {
      sawNotFound++;
      continue;
    }
    failed.push({ type, reason: res.message || "ResellerClub gave no reason" });
  }

  if (failed.length === RC_DNS_TYPES.length) {
    /* Nothing answered. If every type said "not found" that is an empty zone; if
       every type errored, we know nothing at all. */
    return { kind: "hard_failure", reason: failed[0].reason };
  }
  if (sawNotFound === RC_DNS_TYPES.length) {
    return { kind: "not_found", reason: "ResellerClub reports no DNS zone for this domain — DNS management may not be active" };
  }
  if (failed.length > 0) return { kind: "partial", records, failed };
  return { kind: "listed", records };
}

/* ── Writes ─────────────────────────────────────────────────────────────────── */

export async function rcAddDnsRecord(
  domainName: string,
  customerId: string,
  input: RcDnsRecordInput,
): Promise<RcDnsWriteOutcome> {
  if (!rcOrderingEnabled()) {
    return { kind: "refused", reason: "domain changes are switched off in this environment (DOMAIN_REGISTER_LIVE is not 1)" };
  }
  if (!RC_DNS_TYPES.includes(input.type)) {
    return { kind: "refused", reason: `ResellerClub has no endpoint for a ${input.type} record` };
  }
  const missing = missingForType(input);
  if (missing.length > 0) {
    return { kind: "refused", reason: `cannot add this ${input.type} record — missing ${missing.join(", ")}` };
  }

  const domain = domainName.trim().toLowerCase();
  const ttlUsed = clampTtl(input.ttl);
  const params: Record<string, string> = {
    "domain-name": domain,
    "customer-id": customerId.trim(),
    host: hostFor(input.host, domain),
    value: input.value.toString().trim(),
    ttl: String(ttlUsed),
  };
  if (input.type === "MX" || input.type === "SRV") params.priority = String(input.priority);
  if (input.type === "SRV") {
    params.weight = String(input.weight);
    params.port = String(input.port);
  }

  const res = await rcCall(ADD_ENDPOINT[input.type], params, "POST", { allowScalar: true });
  if (res.status !== "success") {
    return { kind: "hard_failure", reason: res.message || `ResellerClub refused the ${input.type} record` };
  }
  const id = res.data?.["value"] ?? res.data?.["recordid"] ?? null;
  return { kind: "done", providerRecordId: id === null ? null : String(id), ttlUsed };
}

export async function rcModifyDnsRecord(
  domainName: string,
  providerRecordId: string,
  input: RcDnsRecordInput,
): Promise<RcDnsWriteOutcome> {
  if (!rcOrderingEnabled()) {
    return { kind: "refused", reason: "domain changes are switched off in this environment (DOMAIN_REGISTER_LIVE is not 1)" };
  }
  if (!providerRecordId.trim()) {
    return { kind: "refused", reason: "no ResellerClub record id — a modify cannot guess which record it means" };
  }
  const missing = missingForType(input);
  if (missing.length > 0) {
    return { kind: "refused", reason: `cannot modify this ${input.type} record — missing ${missing.join(", ")}` };
  }

  const domain = domainName.trim().toLowerCase();
  const ttlUsed = clampTtl(input.ttl);
  const params: Record<string, string> = {
    "domain-name": domain,
    "record-id": providerRecordId.trim(),
    type: input.type,
    host: hostFor(input.host, domain),
    value: input.value.toString().trim(),
    ttl: String(ttlUsed),
  };
  /* Only when the type actually has one. DMS passed `priority: undefined` and
     relied on axios dropping it; this transport takes strings, so an absent
     priority must be absent rather than the string "undefined". */
  if (input.type === "MX" || input.type === "SRV") params.priority = String(input.priority);

  const res = await rcCall("/api/dns/manage/modify-record.json", params, "POST", { allowScalar: true });
  if (res.status !== "success") {
    return { kind: "hard_failure", reason: res.message || "ResellerClub refused the record change" };
  }
  return { kind: "done", providerRecordId: providerRecordId.trim(), ttlUsed };
}

/**
 * Delete one record.
 *
 * RC wants host, value AND type alongside the record id — it does not accept the
 * id alone — so a delete carries enough to identify the record twice over.
 */
export async function rcDeleteDnsRecord(
  domainName: string,
  providerRecordId: string,
  input: Pick<RcDnsRecordInput, "type" | "host" | "value">,
): Promise<RcDnsWriteOutcome> {
  if (!rcOrderingEnabled()) {
    return { kind: "refused", reason: "domain changes are switched off in this environment (DOMAIN_REGISTER_LIVE is not 1)" };
  }
  if (!providerRecordId.trim()) {
    return { kind: "refused", reason: "no ResellerClub record id — a delete cannot guess which record it means" };
  }
  const domain = domainName.trim().toLowerCase();
  const res = await rcCall(
    "/api/dns/manage/delete-record.json",
    {
      "domain-name": domain,
      "record-id": providerRecordId.trim(),
      type: input.type,
      host: hostFor(input.host, domain),
      value: (input.value ?? "").toString().trim(),
    },
    "POST",
    { allowScalar: true },
  );
  if (res.status !== "success") {
    /* A record that is already gone is the state the caller wanted. */
    if (meansAbsent(res.message)) {
      return { kind: "done", providerRecordId: providerRecordId.trim() };
    }
    return { kind: "hard_failure", reason: res.message || "ResellerClub refused the delete" };
  }
  return { kind: "done", providerRecordId: providerRecordId.trim() };
}
