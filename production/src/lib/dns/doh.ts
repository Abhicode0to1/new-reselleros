/**
 * DNS-over-HTTPS lookup.
 *
 * Separated from the API route so the network half can be exercised directly —
 * the route itself is behind a session, which is correct but makes it awkward to
 * prove the lookup works. The judgement half lives in workspace-dns.ts and needs
 * no network at all.
 *
 * Never throws. Every failure comes back as a described error, because the one
 * answer this must never produce is "the customer's DNS is wrong" when what
 * actually happened is that our own lookup timed out.
 */

/** DNS record type numbers. */
export const DNS_TYPE = { MX: 15, TXT: 16 } as const;

export type DohResult =
  | { ok: true; data: string[] }
  /** The domain itself does not exist — distinct from "exists, no such records". */
  | { ok: false; kind: "nxdomain"; error: string }
  | { ok: false; kind: "lookup"; error: string };

interface DohAnswer { name: string; type: number; TTL: number; data: string }
interface DohEnvelope { Status: number; Answer?: DohAnswer[] }

/** A slow DNS answer is a failed one — the operator is on a call with a customer. */
export const DOH_TIMEOUT_MS = 6_000;

export async function resolveDoh(
  domain: string,
  type: number,
  timeoutMs: number = DOH_TIMEOUT_MS,
): Promise<DohResult> {
  try {
    const res = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${type}`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!res.ok) return { ok: false, kind: "lookup", error: `resolver returned HTTP ${res.status}` };

    const json = (await res.json()) as DohEnvelope;
    // Status 3 is NXDOMAIN. Kept distinct from status 0 with no Answer, because
    // the two mean very different things to whoever is reading the result: the
    // domain does not exist, versus it exists and mail simply isn't set up.
    if (json.Status === 3) return { ok: false, kind: "nxdomain", error: "domain does not resolve" };
    if (json.Status !== 0)  return { ok: false, kind: "lookup", error: `resolver status ${json.Status}` };

    // Filter by type: CNAME chains make the resolver return answers of other
    // types alongside the ones asked for.
    return { ok: true, data: (json.Answer ?? []).filter((a) => a.type === type).map((a) => a.data) };
  } catch (err) {
    const name = (err as Error)?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return {
      ok: false, kind: "lookup",
      error: timedOut ? `no answer within ${timeoutMs}ms` : (err as Error)?.message ?? "lookup failed",
    };
  }
}

/**
 * Normalise what people actually paste — a URL, a trailing dot, a leading www —
 * into a bare domain. Returns null when the result still isn't domain-shaped.
 *
 * The check is deliberately narrower than the DNS spec: this value goes into a URL
 * that is then fetched, and a permissive check is how a query parameter becomes a
 * request somewhere that is not a DNS resolver.
 */
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normaliseDomainInput(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^.*@/, "")        // someone pastes an email address
    .replace(/\.$/, "");
  const domain = raw.startsWith("www.") ? raw.slice(4) : raw;
  return DOMAIN_RE.test(domain) ? domain : null;
}
