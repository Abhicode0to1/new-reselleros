/**
 * "Tell me if this domain becomes free" — deciding when that email may be sent.
 *
 * Ported from the DMS engine's `DomainWatch` model on 10 Sep 2026. DMS had the
 * table and nothing that read it; this is the part that was missing.
 *
 * ─── THE WHOLE RISK IS THE EMAIL ─────────────────────────────────────────────
 * "acme.com is available!" about a name that is NOT available is worse than
 * silence. The customer tries to buy it, fails, and stops trusting anything else
 * we send — including the expiry warnings on /portal/domains, which are the ones
 * that actually cost money to ignore.
 *
 * So the rule is one-directional and it is the reason this file exists:
 * an email needs a POSITIVE `available` reading. Never the absence of a `taken`
 * one. A failed check, an unreachable registrar, an unparseable response and a
 * TLD we cannot price all mean UNKNOWN, and unknown never notifies.
 *
 * That is the same asymmetry as `rcAvailability` returning `available: null`
 * rather than false, and `lib/domains/lifecycle.ts` returning null for "leave it
 * alone" — an error read as an absence is the defect family this codebase has
 * now fixed five times in ported code.
 */

/** What the last check established. `unknown` is a real answer. */
export type WatchStatus = "available" | "taken" | "unknown";

/** Stop checking a name after this many consecutive failures. */
export const MAX_WATCH_ERRORS = 10;

/** How long between checks for one watch. */
export const WATCH_INTERVAL_HOURS = 24;

export interface WatchRow {
  domain_name: string;
  last_checked_at: string | null;
  last_status: string;
  notified_at: string | null;
  consecutive_errors: number;
}

const asDate = (v: string | Date | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
};

/* ── Should this watch be checked at all? ────────────────────────────────────── */

export type CheckDecision =
  | { kind: "check" }
  | { kind: "skip"; reason: string };

export function shouldCheck(row: WatchRow, now: Date = new Date()): CheckDecision {
  if (asDate(row.notified_at)) {
    /* A watch is a one-shot alert, not a subscription. Once told, done. */
    return { kind: "skip", reason: "the customer has already been told" };
  }
  if ((row.consecutive_errors ?? 0) >= MAX_WATCH_ERRORS) {
    /* Usually a TLD the registrar will not answer for. Asking forever is noise
       in the logs and load on an API somebody pays for. */
    return { kind: "skip", reason: `${row.consecutive_errors} checks in a row have failed — this name is no longer being checked` };
  }
  const last = asDate(row.last_checked_at);
  if (!last) return { kind: "check" };

  const due = new Date(last.getTime() + WATCH_INTERVAL_HOURS * 3_600_000);
  if (now.getTime() < due.getTime()) {
    return { kind: "skip", reason: `checked less than ${WATCH_INTERVAL_HOURS}h ago` };
  }
  return { kind: "check" };
}

/* ── May we email? ───────────────────────────────────────────────────────────── */

/**
 * The reading from an availability check, as `rcAvailability` reports it.
 *
 * `available: null` is RC saying it could not determine this name — see
 * `lib/resellerclub/index.ts` on the concatenated-key case. It is deliberately
 * representable here so it cannot be flattened into a boolean on the way in.
 */
export interface AvailabilityReading {
  available: boolean | null;
}

/** What one check establishes about a watch. */
export function statusFromReading(reading: AvailabilityReading | null | undefined): WatchStatus {
  if (!reading) return "unknown";
  if (reading.available === true) return "available";
  if (reading.available === false) return "taken";
  /* null — RC answered for the batch but not usefully for this name. */
  return "unknown";
}

export type NotifyDecision =
  | { notify: true }
  | { notify: false; reason: string };

/**
 * May the "it's available" email go out?
 *
 * ONLY on a positive reading, and only once. Everything else is a refusal with a
 * reason, because the reasons differ and a log that says "not notifying" tells
 * whoever reads it nothing.
 */
export function shouldNotify(row: WatchRow, status: WatchStatus): NotifyDecision {
  if (asDate(row.notified_at)) {
    return { notify: false, reason: "already notified — a watch is a one-shot alert" };
  }
  if (status === "available") return { notify: true };
  if (status === "taken") {
    return { notify: false, reason: "still registered to somebody else" };
  }
  /* The important branch. An unreadable check must never be able to send this. */
  return {
    notify: false,
    reason: "the registrar could not tell us whether this name is free, and an unknown reading never triggers the email",
  };
}

/* ── Bookkeeping after a check ───────────────────────────────────────────────── */

export interface WatchUpdate {
  last_checked_at: string;
  last_status: WatchStatus;
  consecutive_errors: number;
  last_error: string | null;
  notified_at?: string;
}

/**
 * The row as it should look after one check.
 *
 * The error counter RESETS on any conclusive reading — available or taken — and
 * only increments on unknown. A name that answered today has clearly not run out
 * of retries, whatever happened last week.
 */
export function applyCheck(
  row: WatchRow,
  status: WatchStatus,
  opts: { error?: string | null; notified?: boolean; now?: Date } = {},
): WatchUpdate {
  const now = opts.now ?? new Date();
  const conclusive = status === "available" || status === "taken";

  const update: WatchUpdate = {
    last_checked_at: now.toISOString(),
    last_status: status,
    consecutive_errors: conclusive ? 0 : (row.consecutive_errors ?? 0) + 1,
    last_error: conclusive ? null : (opts.error ?? "the registrar gave no usable answer"),
  };
  if (opts.notified) update.notified_at = now.toISOString();
  return update;
}

/* ── What the customer is asked for ──────────────────────────────────────────── */

/**
 * Is this something we can actually watch?
 *
 * A watch on a name we cannot check is a promise that will never be kept, so the
 * refusal belongs at the point of asking rather than in a sweep nobody reads.
 * Deliberately strict about the shape and does NOT try to validate the TLD — a
 * TLD list in code goes stale, and the first check will establish it either way.
 */
export function watchableDomain(raw: string): { ok: true; domain: string } | { ok: false; reason: string } {
  const domain = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");

  if (!domain) return { ok: false, reason: "Enter a domain name to watch." };
  if (!domain.includes(".")) {
    return { ok: false, reason: "That needs to be a full domain name, with the ending — acme.com, not acme." };
  }
  if (domain.length > 253) return { ok: false, reason: "That domain name is too long to be real." };
  /* A label may not START OR END with a hyphen (RFC 1123). The first version of
     this only guarded the start — a negative lookahead — so "acme-.com" passed.
     Caught by a test case, not by reading it. */
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    return { ok: false, reason: "That does not look like a domain name. Letters, numbers and hyphens only." };
  }
  return { ok: true, domain };
}

/** Cap per customer, so one person cannot queue a thousand daily checks. */
export const MAX_WATCHES_PER_CUSTOMER = 20;

export function canAddWatch(currentCount: number): { ok: true } | { ok: false; reason: string } {
  if (currentCount >= MAX_WATCHES_PER_CUSTOMER) {
    return {
      ok: false,
      reason: `You are already watching ${MAX_WATCHES_PER_CUSTOMER} names, which is the most we check daily. Remove one to add another.`,
    };
  }
  return { ok: true };
}

/**
 * `acme.co.in` → name `acme`, tld `co.in`.
 *
 * Splits on the FIRST dot, not the last. `rcAvailability` takes a bare label
 * plus a TLD, and for a multi-level TLD the label is only the first part —
 * splitting on the last dot would ask ResellerClub about "acme.co" under ".in",
 * which is a different name that may well be free while the one the customer
 * watched is not. That is the wrong answer in the direction that sends an email.
 *
 * Returns null rather than guessing when there is no usable split.
 */
export function splitDomain(domain: string): { name: string; tld: string } | null {
  const d = (domain ?? "").trim().toLowerCase();
  const i = d.indexOf(".");
  if (i <= 0 || i === d.length - 1) return null;
  const name = d.slice(0, i);
  const tld = d.slice(i + 1);
  if (!name || !tld || tld.startsWith(".") || tld.endsWith(".")) return null;
  return { name, tld };
}
