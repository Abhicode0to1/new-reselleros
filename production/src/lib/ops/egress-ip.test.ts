import { describe, it, expect } from "vitest";
import {
  parseIpv4,
  assessEgress,
  egressNeedsAction,
  IP_PROBES,
  type ProbeResult,
} from "./egress-ip";

/**
 * Both upstreams gate on our egress IP and NEITHER names it when refusing —
 * ResellerClub returns an error whose text has to be read to tell it from a bad
 * key, DirectAdmin returns its HTML login page. So this is the answer to the
 * first question asked when a paid domain order starts failing.
 *
 * The mistake to avoid is the same one as everywhere else in this port: a probe
 * that could not be reached must never be reported as a wrong IP, because that
 * sends somebody to edit an allowlist that was never the problem.
 */

const probe = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  service: "https://api.ipify.org",
  ip: null,
  error: null,
  ms: 42,
  ...over,
});

describe("parseIpv4 — strict, because the value goes into an `inet` column", () => {
  it("accepts real addresses", () => {
    expect(parseIpv4("34.14.190.227")).toBe("34.14.190.227");
    expect(parseIpv4("  8.8.8.8\n")).toBe("8.8.8.8");
    expect(parseIpv4("0.0.0.0")).toBe("0.0.0.0");
  });

  it("rejects anything that is not one", () => {
    /* A probe answering with an error page, a redirect notice or HTML must not
       be stored as though it were an address — Postgres would reject the write
       and the whole check would fail on a save instead of reporting a bad probe. */
    for (const bad of ["", "   ", "not an ip", "<html>error</html>", "34.14.190", "34.14.190.227.1", "999.1.1.1", "34.14.190.256"]) {
      expect(parseIpv4(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("rejects a leading zero, which is not unambiguously the address it looks like", () => {
    /* Some resolvers read 010.1.1.1 as octal. */
    expect(parseIpv4("010.1.1.1")).toBeNull();
    expect(parseIpv4("1.02.3.4")).toBeNull();
  });

  it("rejects IPv6, which is not the thing being compared", () => {
    /* Both allowlists hold a v4 address, so treating a v6 answer as the observed
       IP would produce a mismatch that means nothing. */
    expect(parseIpv4("2001:4860:4860::8888")).toBeNull();
    expect(parseIpv4("::1")).toBeNull();
  });

  it("is safe on nothing", () => {
    expect(parseIpv4(null)).toBeNull();
    expect(parseIpv4(undefined)).toBeNull();
  });
});

describe("assessEgress — an unreachable probe is NOT a mismatch", () => {
  it("says UNKNOWN when nothing answered, and says so in words", () => {
    /* The important case. Reporting this as "your IP is wrong" would send
       somebody to edit an allowlist that was never the problem. */
    const a = assessEgress(
      [probe({ error: "fetch failed" }), probe({ service: "b", error: "timeout" })],
      "34.14.190.227",
    );
    expect(a.verdict).toBe("unknown");
    expect(a.observedIp).toBeNull();
    expect(a.observedIps).toEqual([]);
    expect(a.summary).toMatch(/does NOT mean the address is wrong/i);
  });

  it("stays UNKNOWN even when an expectation is configured", () => {
    /* Having something to compare against does not create something to compare. */
    expect(assessEgress([probe({ error: "x" })], "34.14.190.227").verdict).toBe("unknown");
  });

  it("treats a 200 whose body is not an address as no answer", () => {
    expect(assessEgress([probe({ ip: "<html>" })], "34.14.190.227").verdict).toBe("unknown");
  });
});

describe("assessEgress — match and mismatch", () => {
  it("matches, and says the IP is not the reason for a refusal", () => {
    const a = assessEgress([probe({ ip: "34.14.190.227" })], "34.14.190.227");
    expect(a.verdict).toBe("match");
    expect(a.observedIp).toBe("34.14.190.227");
    expect(a.summary).toMatch(/not the reason/);
  });

  it("mismatches, names BOTH addresses, and says what each upstream will do", () => {
    /* The operator reading this is diagnosing a failing order. "IP mismatch"
       alone does not tell them that DA's login page IS the symptom (§24). */
    const a = assessEgress([probe({ ip: "35.200.1.5" })], "34.14.190.227");
    expect(a.verdict).toBe("mismatch");
    expect(a.summary).toContain("35.200.1.5");
    expect(a.summary).toContain("34.14.190.227");
    expect(a.summary).toMatch(/login page/);
    expect(a.summary).toMatch(/allowlist|restore/);
  });

  it("agrees across probes that all report the same address", () => {
    const a = assessEgress(
      [probe({ ip: "34.14.190.227" }), probe({ service: "b", ip: "34.14.190.227" }), probe({ service: "c", ip: "34.14.190.227" })],
      "34.14.190.227",
    );
    expect(a.verdict).toBe("match");
    expect(a.observedIps).toEqual(["34.14.190.227"]);
  });

  it("ignores a failed probe alongside a successful one", () => {
    const a = assessEgress(
      [probe({ error: "timeout" }), probe({ service: "b", ip: "34.14.190.227" })],
      "34.14.190.227",
    );
    expect(a.verdict).toBe("match");
  });
});

describe("assessEgress — disagreement is a finding, not a tie to break", () => {
  it("reports DISAGREE rather than picking the first answer", () => {
    /* DMS took whichever service replied first. A service can legitimately
       egress from more than one address, and only one of them can be on an
       allowlist — so requests would succeed or fail depending on which path a
       given call happened to take. That is worth seeing, not resolving. */
    const a = assessEgress(
      [probe({ ip: "34.14.190.227" }), probe({ service: "b", ip: "35.200.1.5" })],
      "34.14.190.227",
    );
    expect(a.verdict).toBe("disagree");
    expect(a.observedIp).toBeNull();
    expect(a.observedIps).toEqual(["34.14.190.227", "35.200.1.5"]);
    expect(a.summary).toMatch(/disagreed/);
  });

  it("does not call it a match just because the expected address is among them", () => {
    /* The trap: one probe says the right thing, so it looks fine. It is not —
       half the calls still go out from the other address. */
    const a = assessEgress(
      [probe({ ip: "34.14.190.227" }), probe({ service: "b", ip: "35.200.1.5" })],
      "34.14.190.227",
    );
    expect(a.verdict).not.toBe("match");
  });

  it("keeps first-seen order and does not duplicate", () => {
    const a = assessEgress(
      [probe({ ip: "1.1.1.1" }), probe({ service: "b", ip: "2.2.2.2" }), probe({ service: "c", ip: "1.1.1.1" })],
      null,
    );
    expect(a.observedIps).toEqual(["1.1.1.1", "2.2.2.2"]);
  });
});

describe("assessEgress — nothing to compare against", () => {
  it("says UNVERIFIED and names the setting, rather than claiming a match", () => {
    /* With no configured expectation there is no claim to make. Reporting
       "match" would be inventing agreement with nothing. */
    const a = assessEgress([probe({ ip: "34.14.190.227" })], null);
    expect(a.verdict).toBe("unverified");
    expect(a.observedIp).toBe("34.14.190.227");
    expect(a.expectedIp).toBeNull();
    expect(a.summary).toMatch(/EXPECTED_EGRESS_IP/);
  });

  it("treats an unparseable expectation as no expectation", () => {
    /* A typo in the env var must not read as a mismatch against every real
       address — that would be a permanent false alarm. */
    for (const bad of ["", "  ", "not-an-ip", "34.14.190"]) {
      const a = assessEgress([probe({ ip: "34.14.190.227" })], bad);
      expect(a.verdict, JSON.stringify(bad)).toBe("unverified");
    }
  });
});

describe("egressNeedsAction", () => {
  it("flags the two verdicts somebody has to act on", () => {
    expect(egressNeedsAction("mismatch")).toBe(true);
    expect(egressNeedsAction("disagree")).toBe(true);
  });

  it("does not flag the three that need nothing", () => {
    /* `unknown` deliberately included: a probe outage is not our problem to
       fix, and paging on it teaches people to ignore this. */
    expect(egressNeedsAction("match")).toBe(false);
    expect(egressNeedsAction("unknown")).toBe(false);
    expect(egressNeedsAction("unverified")).toBe(false);
  });
});

describe("the probe list", () => {
  it("asks more than one service, over plain text", () => {
    /* Three so a single outage does not leave the question unanswerable; plain
       text because a bare address is unambiguous where a JSON shape is one more
       thing that can change under us. */
    expect(IP_PROBES.length).toBeGreaterThanOrEqual(3);
    for (const p of IP_PROBES) expect(p).toMatch(/^https:\/\//);
  });

  it("names distinct hosts, so one provider's outage is not all three", () => {
    const hosts = IP_PROBES.map((p) => new URL(p).host);
    expect(new Set(hosts).size).toBe(hosts.length);
  });
});
