import { describe, it, expect } from "vitest";
import {
  parseZoneFile,
  parseNumberedRecords,
  looksLikeZoneFile,
  deleteSelector,
  refuseReason,
  DA_DNS_TYPES,
  DA_DEFAULT_TTL,
} from "./dns";
import { isDaUsername, loginAsUser } from "./user-auth";

/**
 * DirectAdmin answers the DNS endpoint in two unrelated shapes, and the whole
 * risk of this module is reading one of them as "the zone is empty". An empty
 * zone read is what makes a reconcile delete live records — the same failure
 * `resellerclub/dns.ts` is built around avoiding.
 */

describe("looksLikeZoneFile — telling the two shapes apart", () => {
  it("recognises a zone file by its directives", () => {
    expect(looksLikeZoneFile("$TTL 14400\nacme.com. 14400 IN A 203.0.113.10")).toBe(true);
    expect(looksLikeZoneFile("$ORIGIN acme.com.")).toBe(true);
  });

  it("recognises one with no directives, by its records", () => {
    expect(looksLikeZoneFile("acme.com.\t14400\tIN\tA\t203.0.113.10")).toBe(true);
  });

  it("does not mistake DA's numbered fields for a zone file", () => {
    expect(looksLikeZoneFile("name0=acme.com.&value0=203.0.113.10&type0=A&ttl0=14400")).toBe(false);
  });

  it("treats an empty body as neither", () => {
    expect(looksLikeZoneFile("")).toBe(false);
    expect(looksLikeZoneFile("   ")).toBe(false);
  });
});

describe("parseZoneFile — the fallback DMS carried, and why it is kept", () => {
  const zone = [
    "; a comment",
    "$TTL 14400",
    "$ORIGIN acme.com.",
    "",
    "acme.com.\t14400\tIN\tA\t203.0.113.10",
    "www\t3600\tIN\tCNAME\tacme.com.",
    "acme.com.\tIN\tTXT\t\"v=spf1 include:_spf.google.com ~all\"",
  ].join("\n");

  it("reads records, skipping comments, directives and blanks", () => {
    const recs = parseZoneFile(zone);
    expect(recs.map((r) => r.type)).toEqual(["A", "CNAME", "TXT"]);
    expect(recs[0]).toEqual({ name: "acme.com.", ttl: 14400, type: "A", value: "203.0.113.10", key: null });
    expect(recs[1].ttl).toBe(3600);
  });

  it("accepts a record with no TTL, because the format makes it optional", () => {
    const recs = parseZoneFile(zone);
    expect(recs[2].ttl).toBeNull();
    expect(recs[2].value).toBe('"v=spf1 include:_spf.google.com ~all"');
  });

  it("reports key as null, so a caller knows a delete needs a name+value selector", () => {
    expect(parseZoneFile(zone).every((r) => r.key === null)).toBe(true);
  });

  it("returns an empty list for junk rather than throwing", () => {
    expect(parseZoneFile("")).toEqual([]);
    expect(parseZoneFile("total nonsense\nmore nonsense")).toEqual([]);
  });
});

describe("parseNumberedRecords — DA's usual shape", () => {
  it("walks name0..nameN and stops at the gap", () => {
    const recs = parseNumberedRecords({
      name0: "acme.com.", value0: "203.0.113.10", type0: "a", ttl0: "14400", key0: "k1",
      name1: "www", value1: "acme.com.", type1: "CNAME", ttl1: "3600",
      /* name2 absent on purpose — the loop must stop here and not read name3. */
      name3: "never", value3: "read",
    });
    expect(recs).toHaveLength(2);
    expect(recs[0]).toEqual({ name: "acme.com.", value: "203.0.113.10", type: "A", ttl: 14400, key: "k1" });
    expect(recs[1].key).toBeNull();
  });

  it("upper-cases the type, so callers can compare against one spelling", () => {
    expect(parseNumberedRecords({ name0: "@", value0: "x", type0: "txt" })[0].type).toBe("TXT");
  });

  it("reports a missing or zero TTL as null, not as 0", () => {
    expect(parseNumberedRecords({ name0: "@", value0: "x", type0: "A" })[0].ttl).toBeNull();
    expect(parseNumberedRecords({ name0: "@", value0: "x", type0: "A", ttl0: "0" })[0].ttl).toBeNull();
  });

  it("returns nothing when DA sent no records", () => {
    expect(parseNumberedRecords({})).toEqual([]);
    expect(parseNumberedRecords({ error: "0", text: "ok" })).toEqual([]);
  });
});

describe("deleteSelector — DMS built this unencoded", () => {
  it("prefers DA's own record key when there is one", () => {
    expect(deleteSelector({ name: "@", value: "x", key: "da-key-7" })).toBe("da-key-7");
  });

  it("ENCODES a name+value selector, which is the fix", () => {
    /* DMS built `name=${name}&value=${value}` raw, so a TXT value — which
       routinely contains = and ; and & — produced a selector for a different
       record, or for none at all. */
    const sel = deleteSelector({
      name: "acme.com.",
      value: "v=spf1 include:_spf.google.com ~all",
      key: null,
    });
    expect(sel).not.toContain("v=spf1 include");
    const parsed = new URLSearchParams(sel);
    expect(parsed.get("name")).toBe("acme.com.");
    expect(parsed.get("value")).toBe("v=spf1 include:_spf.google.com ~all");
  });

  it("survives a value containing an ampersand", () => {
    const sel = deleteSelector({ name: "@", value: "a&b=c", key: null });
    expect(new URLSearchParams(sel).get("value")).toBe("a&b=c");
  });
});

describe("refuseReason — what it will not send", () => {
  it("REFUSES MX and SRV rather than sending a record with no priority", () => {
    /* DMS's addDNSRecord had no priority field at all, so an MX added through it
       carried none — and an MX with no priority is a mail outage. There is no DA
       server here to verify the parameter shape against, so this refuses. */
    for (const type of ["MX", "mx", "SRV"]) {
      const why = refuseReason({ type, value: "mail.acme.com." });
      expect(why).toBeTruthy();
      expect(why).toMatch(/priority/);
      expect(why).toMatch(/verify|guess/);
    }
  });

  it("refuses a type DA DNS is not being driven for here", () => {
    expect(refuseReason({ type: "CAA", value: "x" })).toMatch(/supports/);
    expect(refuseReason({ type: "", value: "x" })).toMatch(/empty type/);
  });

  it("refuses a record with no value", () => {
    expect(refuseReason({ type: "A", value: "   " })).toMatch(/no value/);
  });

  it("allows the types it does support", () => {
    for (const type of DA_DNS_TYPES) {
      expect(refuseReason({ type, value: "203.0.113.10" })).toBeNull();
    }
  });

  it("keeps DA's four-hour default available rather than hardcoding it", () => {
    /* DMS hardcoded 14400 with no way to pass one. It is a default here. */
    expect(DA_DEFAULT_TTL).toBe(14400);
  });
});

describe("the Login-As identity", () => {
  it("accepts real DA usernames and rejects anything that could redirect the account", () => {
    expect(isDaUsername("acmecorp1")).toBe(true);
    /* A pipe in the username would change which account is acted on. */
    for (const bad of ["admin|root", "ACME", "acme-corp", "acme corp", "", "a".repeat(33), "acme;x"]) {
      expect(isDaUsername(bad)).toBe(false);
    }
  });

  it("builds the pipe form, which is what makes the call act as the customer", () => {
    /* DIRECTADMIN_ADMIN_USER is unset in tests, so the prefix is empty — the
       shape is what matters here, and the wire format is proved end-to-end
       against a stand-in that records the header it received. */
    expect(loginAsUser("acmecorp1")).toContain("|acmecorp1");
  });
});
