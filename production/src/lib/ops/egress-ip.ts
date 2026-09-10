/**
 * Which IP address does this deployment call out from?
 *
 * Ported from the DMS engine's `IPCheck` on 10 Sep 2026, with the comparison it
 * left to the reader done here instead.
 *
 * ─── WHY IT MATTERS MORE THAN IT LOOKS ───────────────────────────────────────
 * Both upstream integrations gate on our egress IP, and neither says so when it
 * refuses:
 *   · ResellerClub answers a non-allowlisted caller with an error whose text has
 *     to be read to tell it apart from a bad api-key;
 *   · DirectAdmin answers with its HTML LOGIN PAGE, which looks exactly like
 *     wrong credentials.
 * So "has our egress IP changed?" is the first question when either goes dark,
 * and answering it by hand means finding somebody with cloud console access.
 *
 * ─── CONSENSUS, NOT THE FIRST ANSWER ─────────────────────────────────────────
 * DMS probed several services and took the first that replied. A Cloud Run
 * service can legitimately egress from more than one address, so two probes
 * disagreeing is not noise — it is the finding, and it is reported as its own
 * verdict rather than resolved by whichever service was fastest.
 *
 * ─── AND AN UNREACHABLE PROBE IS NOT A MISMATCH ──────────────────────────────
 * If nothing answers, nothing is established. Reporting that as "your IP is
 * wrong" would send somebody to edit an allowlist that was never the problem —
 * the same error-as-absence trap this codebase keeps closing.
 */

/**
 * Services asked "what is my IP".
 *
 * Plain-text endpoints on purpose: a bare address is unambiguous, where a JSON
 * shape is one more thing that can change under us. Three rather than one so a
 * single outage does not leave the question unanswerable, and three rather than
 * six because each one is a round trip on a diagnostic somebody is waiting for.
 */
export const IP_PROBES = [
  "https://api.ipify.org",
  "https://ipv4.icanhazip.com",
  "https://checkip.amazonaws.com",
] as const;

export type EgressVerdict = "match" | "mismatch" | "disagree" | "unknown" | "unverified";

export interface ProbeResult {
  service: string;
  ip: string | null;
  error: string | null;
  ms: number;
}

export interface EgressAssessment {
  verdict: EgressVerdict;
  /** The agreed address, or null when there is no single one. */
  observedIp: string | null;
  /** Every distinct address seen, first-seen order. More than one is the finding. */
  observedIps: string[];
  expectedIp: string | null;
  /** One sentence, written for whoever is diagnosing a failing order (§24). */
  summary: string;
}

/**
 * An IPv4 address, strictly.
 *
 * Strict because a probe that returns an error page, a redirect notice or a
 * trailing newline plus HTML must not be stored as though it were an address —
 * `inet` in Postgres would reject it and the whole check would fail on a write
 * instead of reporting a bad probe.
 *
 * IPv6 is deliberately not accepted: the allowlists on both upstreams hold a
 * v4 address, so a v6 answer is not the thing being compared and treating it as
 * one would produce a mismatch that means nothing.
 */
export function parseIpv4(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;
  const parts = s.split(".").map(Number);
  if (parts.some((n) => n > 255)) return null;
  /* Reject a leading zero ("01.2.3.4"): some resolvers read it as octal, so it
     is not unambiguously the address it looks like. */
  if (s.split(".").some((p) => p.length > 1 && p.startsWith("0"))) return null;
  return parts.join(".");
}

/**
 * What the probes established, and whether it is what the upstreams expect.
 *
 * Pure — takes the probe results rather than performing them, so every verdict
 * can be tested without a network.
 */
export function assessEgress(
  probes: ReadonlyArray<ProbeResult>,
  expectedRaw: string | null | undefined,
): EgressAssessment {
  const expectedIp = parseIpv4(expectedRaw);

  /* Distinct, first-seen order. A probe that failed contributes nothing — not a
     null entry, which would look like an address nobody could read. */
  const observedIps: string[] = [];
  for (const p of probes) {
    const ip = parseIpv4(p.ip);
    if (ip && !observedIps.includes(ip)) observedIps.push(ip);
  }

  if (observedIps.length === 0) {
    return {
      verdict: "unknown",
      observedIp: null,
      observedIps: [],
      expectedIp,
      summary:
        "None of the IP-lookup services answered, so this deployment's outbound address could not be established. That does NOT mean the address is wrong — it means we do not know it right now.",
    };
  }

  if (observedIps.length > 1) {
    return {
      verdict: "disagree",
      observedIp: null,
      observedIps,
      expectedIp,
      summary:
        `The lookup services disagreed — this deployment was seen calling out from ${observedIps.join(" and ")}. ` +
        `That can be legitimate on a service with more than one egress path, but only one address can be on an upstream allowlist, ` +
        `so requests will succeed or fail depending on which one a given call happens to use.`,
    };
  }

  const observedIp = observedIps[0];

  if (!expectedIp) {
    return {
      verdict: "unverified",
      observedIp,
      observedIps,
      expectedIp: null,
      summary:
        `This deployment calls out from ${observedIp}. Nothing is configured to compare that against ` +
        `(set EXPECTED_EGRESS_IP to the address ResellerClub and DirectAdmin have been told to allow), ` +
        `so no claim is being made about whether it is right.`,
    };
  }

  if (observedIp === expectedIp) {
    return {
      verdict: "match",
      observedIp,
      observedIps,
      expectedIp,
      summary: `This deployment calls out from ${observedIp}, which is the address the upstreams expect. If ResellerClub or DirectAdmin are refusing us, the IP is not the reason.`,
    };
  }

  return {
    verdict: "mismatch",
    observedIp,
    observedIps,
    expectedIp,
    summary:
      `This deployment is calling out from ${observedIp}, but the upstreams have been told to expect ${expectedIp}. ` +
      `ResellerClub will be refusing us, and DirectAdmin will be answering with its login page — neither of which says so. ` +
      `Either add ${observedIp} to both allowlists, or restore the static egress address.`,
  };
}

/** Does this verdict need somebody to do something? */
export function egressNeedsAction(verdict: EgressVerdict): boolean {
  return verdict === "mismatch" || verdict === "disagree";
}

/**
 * Ask one service, with a short timeout.
 *
 * The timeout is deliberately tight: this runs while somebody waits on a
 * diagnostics page, and a slow probe is worth less than a fast "did not answer".
 */
export async function probeOnce(service: string, timeoutMs = 4000): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const res = await fetch(service, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      return { service, ip: null, error: `HTTP ${res.status}`, ms: Date.now() - started };
    }
    const ip = parseIpv4(text);
    return {
      service,
      ip,
      /* A 200 whose body is not an address is a probe problem, and saying so is
         more useful than a silent null. */
      error: ip ? null : `answered with something that is not an IPv4 address: ${text.trim().slice(0, 40)}`,
      ms: Date.now() - started,
    };
  } catch (err) {
    return { service, ip: null, error: (err as Error).message || "unreachable", ms: Date.now() - started };
  }
}

/** Ask all of them, in parallel. One slow service must not serialise the rest. */
export async function probeAll(services: readonly string[] = IP_PROBES): Promise<ProbeResult[]> {
  return Promise.all(services.map((s) => probeOnce(s)));
}
