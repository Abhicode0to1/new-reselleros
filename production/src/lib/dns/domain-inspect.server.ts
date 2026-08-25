/**
 * The actual MX lookup. One query, bounded, and it never throws.
 *
 * Node's resolver, not an HTTP DNS-over-HTTPS service: this runs on Cloud Run where the
 * platform resolver is already there, and adding a third-party lookup API would mean another
 * key, another vendor, and a customer's domain leaving our infrastructure to be resolved.
 *
 * ─── EVERY FAILURE IS THE SAME FAILURE ──────────────────────────────────────
 * NXDOMAIN, no MX, SERVFAIL, timeout — all of them come back as an empty record list, because
 * from the agent's side they are one situation: we could not see what their mail runs on, so we
 * ask them. Splitting them into different customer-facing behaviours would be inventing
 * distinctions the customer cannot act on, and `inspectionFacts` already words the empty case as
 * "probably a typo, ask them" rather than as "you have no email".
 */
import { Resolver } from "node:dns/promises";
import { normaliseDomain, type MxRecord } from "./domain-inspect";

/**
 * How long a lookup may take.
 *
 * Three seconds. This runs while a customer is waiting on a reply, and a slow resolver must
 * cost the agent a fact rather than cost the customer their answer — the reply is still useful
 * without knowing who their host is, and useless if it never arrives.
 */
export const LOOKUP_TIMEOUT_MS = 3_000;

/** How many MX hosts are worth reading. A domain with fifty is not telling us anything more. */
const MAX_RECORDS = 10;

export interface DomainLookup {
  /** The domain as actually queried, or null when the input was not usable. */
  domain: string | null;
  mx: MxRecord[];
  /** True when the query ran and came back — false on timeout, refusal or a bad domain. */
  resolved: boolean;
}

/**
 * Look up a domain's MX records.
 *
 * @param raw whatever the customer typed — normalised and validated before anything resolves.
 */
export async function lookupDomainMx(raw: string | null | undefined): Promise<DomainLookup> {
  const domain = normaliseDomain(raw);
  if (!domain) return { domain: null, mx: [], resolved: false };

  /* A fresh Resolver per call so the timeout below cannot leak into anything else, and so a
     hung query is cancelled rather than left holding a socket. */
  const resolver = new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 1 });

  try {
    const records = await Promise.race([
      resolver.resolveMx(domain),
      /* Belt and braces on top of the resolver's own timeout: `tries: 1` plus `timeout` should
         bound this, and a race guarantees it even if the platform resolver ignores them. */
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("dns timeout")), LOOKUP_TIMEOUT_MS + 500),
      ),
    ]);

    const mx = records
      .filter((r) => typeof r.exchange === "string" && r.exchange.trim())
      .map((r) => ({ exchange: r.exchange.trim().toLowerCase().replace(/\.$/, ""), priority: r.priority }))
      .sort((a, b) => a.priority - b.priority)
      .slice(0, MAX_RECORDS);

    return { domain, mx, resolved: true };
  } catch {
    /* Deliberately not logged per-failure. A customer typing a domain wrong is not an
       application error, and NXDOMAIN is the single most common outcome this function will ever
       have — logging it would fill the logs with other people's typos. */
    return { domain, mx: [], resolved: false };
  } finally {
    /* Cancel anything still in flight. Without this a hung lookup keeps a handle alive past the
       request that started it, which on Cloud Run means it outlives the container that cared. */
    try { resolver.cancel(); } catch { /* already finished */ }
  }
}
