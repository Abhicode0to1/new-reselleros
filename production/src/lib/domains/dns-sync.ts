/**
 * Reconciling ResellerClub's DNS zone against our `dns_records` mirror.
 *
 * ─── WHICH SIDE IS TRUE ──────────────────────────────────────────────────────
 * The registrar is. `dns_records` is a MIRROR, the same way `domains.expires_at`
 * mirrors the registrar's expiry — the migration's split is by source of truth,
 * and DNS lives upstream. So a write goes to RC first and is mirrored only once
 * RC has accepted it, and a read reconciles our rows towards RC's.
 *
 * ─── THE RULE THIS FILE EXISTS FOR ───────────────────────────────────────────
 * A DELETE IS ONLY EVER SAFE ON A COMPLETE READ.
 *
 * `rcListDnsRecords` needs seven calls to list a zone, one per record type, and
 * it reports `partial` when some of them failed. If a reconcile treats a partial
 * list as the whole zone, every record of a type that failed to read has no
 * upstream match — and "no upstream match" is exactly the signal for deleting
 * the local row. One rate-limited MX query would wipe a customer's mail records
 * from the mirror, and the portal would then show a zone with no mail.
 *
 * That is the difference between this module and the DMS code it descends from:
 * DMS could not tell an empty zone from a failed fetch at all, so no reconcile
 * built on it could have been safe. `planDnsSync` therefore refuses to propose a
 * single deletion unless it was handed a complete list, and on a partial list it
 * additionally restricts itself to the types that actually answered.
 */

import type { RcDnsRecord, RcDnsRecordType, RcDnsListOutcome } from "@/lib/resellerclub/dns";
import { RC_DNS_TYPES } from "@/lib/resellerclub/dns";

/** The shape of a row in `dns_records`, as much of it as a sync needs. */
export interface LocalDnsRow {
  id: string;
  record_type: string;
  host: string;
  value: string;
  ttl: number;
  priority: number | null;
  provider_record_id: string | null;
}

export interface DnsSyncPlan {
  insert: RcDnsRecord[];
  /** Local row id paired with the upstream record it should look like. */
  update: Array<{ id: string; to: RcDnsRecord }>;
  /** Local row ids with no upstream counterpart. Empty unless the read was complete. */
  delete: string[];
  /**
   * Why deletes were withheld, when they were. Present exactly when a caller
   * might otherwise wonder why an obviously-stale row survived.
   */
  deletesWithheld: string | null;
  /** Types the upstream read actually covered. Deletes are confined to these. */
  typesCovered: RcDnsRecordType[];
}

/** Same record, upstream and locally? Compared on identity, not on contents. */
function sameRecord(local: LocalDnsRow, remote: RcDnsRecord): boolean {
  /* RC's record id is the only real identity. Where we have it, nothing else
     matters — a record whose value changed upstream is still that record. */
  if (local.provider_record_id && remote.providerRecordId) {
    return local.provider_record_id === remote.providerRecordId;
  }
  /* Without an id, fall back to the natural key. Host comparison is
     case-insensitive because DNS is, and a zone that answers "ACME.com" for a
     record we stored as "acme.com" is not a different record. */
  return (
    local.record_type.toUpperCase() === remote.type &&
    local.host.trim().toLowerCase() === remote.host.trim().toLowerCase() &&
    local.value.trim().toLowerCase() === remote.value.trim().toLowerCase()
  );
}

/** Does the mirror already say what upstream says? */
function contentsMatch(local: LocalDnsRow, remote: RcDnsRecord): boolean {
  return (
    local.record_type.toUpperCase() === remote.type &&
    local.host.trim().toLowerCase() === remote.host.trim().toLowerCase() &&
    local.value.trim() === remote.value.trim() &&
    local.ttl === remote.ttl &&
    (local.priority ?? null) === (remote.priority ?? null) &&
    (local.provider_record_id ?? null) === (remote.providerRecordId ?? null)
  );
}

/**
 * What it would take to make the mirror match upstream.
 *
 * Returns a PLAN and performs nothing — the caller writes, and can log or refuse
 * the plan first. That also makes the interesting half testable without a
 * database.
 */
export function planDnsSync(outcome: RcDnsListOutcome, local: LocalDnsRow[]): DnsSyncPlan {
  const empty: DnsSyncPlan = {
    insert: [], update: [], delete: [], deletesWithheld: null, typesCovered: [],
  };

  /* Nothing was learned. Not a reconcile — see the header. */
  if (outcome.kind === "hard_failure") {
    return { ...empty, deletesWithheld: `the zone could not be read (${outcome.reason}), so nothing was changed` };
  }

  /* RC says there is no zone. That is NOT authority to empty the mirror: DNS
     management may simply not be active on the domain yet, in which case the
     records we hold are the ones somebody will want when it is. */
  if (outcome.kind === "not_found") {
    return {
      ...empty,
      deletesWithheld:
        "ResellerClub reports no DNS zone for this domain, which may only mean DNS management is not active — " +
        "the mirror is left as it is rather than emptied on that evidence",
    };
  }

  const remote = outcome.records;
  const complete = outcome.kind === "listed";

  const typesCovered: RcDnsRecordType[] = complete
    ? [...RC_DNS_TYPES]
    : RC_DNS_TYPES.filter((t) => !outcome.failed.some((f) => f.type === t));

  const plan: DnsSyncPlan = {
    insert: [], update: [], delete: [],
    deletesWithheld: complete
      ? null
      : `the read was incomplete (${outcome.failed.map((f) => f.type).join(", ")} failed), so no local record was deleted`,
    typesCovered,
  };

  const claimed = new Set<string>();

  for (const r of remote) {
    const match = local.find((l) => !claimed.has(l.id) && sameRecord(l, r));
    if (!match) { plan.insert.push(r); continue; }
    claimed.add(match.id);
    if (!contentsMatch(match, r)) plan.update.push({ id: match.id, to: r });
  }

  /* Deletes, and ONLY on a complete read. Even then they are confined to the
     types the read covered, so a future change to RC_DNS_TYPES that adds a type
     we do not query cannot delete records of it. */
  if (complete) {
    for (const l of local) {
      if (claimed.has(l.id)) continue;
      const type = l.record_type.toUpperCase() as RcDnsRecordType;
      if (!typesCovered.includes(type)) continue;
      plan.delete.push(l.id);
    }
  }

  return plan;
}

/** True when applying the plan would change nothing. */
export function planIsNoop(plan: DnsSyncPlan): boolean {
  return plan.insert.length === 0 && plan.update.length === 0 && plan.delete.length === 0;
}

/** A record as it goes into `dns_records`. */
export function toDnsRow(record: RcDnsRecord, tenantId: string, domainId: string) {
  return {
    tenant_id: tenantId,
    domain_id: domainId,
    record_type: record.type,
    host: record.host,
    value: record.value,
    ttl: record.ttl,
    priority: record.priority,
    provider_record_id: record.providerRecordId,
  };
}
