import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * DNS is the part of a domain that can be wrong while everything looks fine.
 *
 * The read tests carry most of the weight, and not because reads are riskier than
 * writes on their own — because of what gets built on top of a read. The module
 * this was ported from could not tell an empty zone from a failed fetch, and
 * anything that reconciles "what RC has" against "what we have" on top of that
 * answer deletes live records the first time RC has a bad minute.
 *
 * Same harness as orders/customers: credentials are read into module constants at
 * import time, so each case re-imports. Nothing here touches the network.
 */

const ENV_KEYS = [
  "RESELLERCLUB_RESELLER_ID",
  "RESELLERCLUB_API_KEY",
  "RESELLERCLUB_API_URL",
  "DOMAIN_REGISTER_LIVE",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

async function load(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  return import("./dns");
}

const CREDS = { RESELLERCLUB_RESELLER_ID: "123456", RESELLERCLUB_API_KEY: "test-key" } as const;
const LIVE = { ...CREDS, DOMAIN_REGISTER_LIVE: "1" } as const;

const DOMAIN = "acmecorp.com";
const CUST = "9001";

/** One response per fetch call; the last repeats if the queue runs out. */
function stubSequence(responses: Array<{ body: unknown; status?: number } | Error>) {
  let i = 0;
  /* The url parameter is declared so `spy.mock.calls[n][0]` is typed — an
     argument-less vi.fn gives an empty tuple and tsc refuses the index. */
  const spy = vi.fn(async (_url?: RequestInfo | URL) => {
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if (next instanceof Error) throw next;
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** Answer every call with the same body. */
function stubAll(body: unknown, status = 200) {
  return stubSequence([{ body, status }]);
}

function urls(spy: ReturnType<typeof vi.fn>): string[] {
  return spy.mock.calls.map((c) => new URL(String(c[0])).pathname);
}
function paramsOf(spy: ReturnType<typeof vi.fn>, i: number): URLSearchParams {
  return new URL(String(spy.mock.calls[i][0])).searchParams;
}

const NOT_FOUND = { status: "ERROR", message: "No records found" };

describe("reading a zone — an incomplete answer must never look complete", () => {
  it("lists records when every type answers", async () => {
    const { rcListDnsRecords } = await load(CREDS);
    stubAll({ recsonpage: 1, recsindb: 1, "1": { type: "A", host: "acmecorp.com", value: "203.0.113.10", timetolive: 7200, recordid: "77" } });
    const out = await rcListDnsRecords(DOMAIN, CUST);
    expect(out.kind).toBe("listed");
    expect(out.kind === "listed" && out.records.length).toBe(7); // one per type queried
    expect(out.kind === "listed" && out.records[0]).toEqual({
      providerRecordId: "77", type: "A", host: "acmecorp.com", value: "203.0.113.10", ttl: 7200, priority: null,
    });
  });

  it("an empty zone is not_found, not an empty success", async () => {
    const { rcListDnsRecords } = await load(CREDS);
    stubAll(NOT_FOUND);
    const out = await rcListDnsRecords(DOMAIN, CUST);
    expect(out.kind).toBe("not_found");
  });

  it("ONE failing type makes the whole read PARTIAL, and names the type", async () => {
    /* The ported defect: DMS logged this as "No MX records found" and returned
       success, so a live zone read as missing its mail. */
    const { rcListDnsRecords } = await load(CREDS);
    stubSequence([
      { body: { "1": { type: "A", host: "acmecorp.com", value: "203.0.113.10", timetolive: 7200, recordid: "1" } } },
      { body: NOT_FOUND },                                              // AAAA
      { body: NOT_FOUND },                                              // CNAME
      { body: { status: "ERROR", message: "IP not whitelisted for API access" } }, // MX
      { body: NOT_FOUND },                                              // NS
      { body: NOT_FOUND },                                              // TXT
      { body: NOT_FOUND },                                              // SRV
    ]);
    const out = await rcListDnsRecords(DOMAIN, CUST);
    expect(out.kind).toBe("partial");
    expect(out.kind === "partial" && out.failed).toEqual([
      { type: "MX", reason: "IP not whitelisted for API access" },
    ]);
    expect(out.kind === "partial" && out.records.length).toBe(1);
  });

  it("everything failing is a hard_failure, never an empty zone", async () => {
    const { rcListDnsRecords } = await load(CREDS);
    stubAll({ status: "ERROR", message: "api key is invalid" });
    const out = await rcListDnsRecords(DOMAIN, CUST);
    expect(out.kind).toBe("hard_failure");
    expect(out.kind === "hard_failure" && out.reason).toMatch(/api key/);
  });

  it("an unreachable RC is a hard_failure too", async () => {
    const { rcListDnsRecords } = await load(CREDS);
    stubSequence([new Error("ETIMEDOUT")]);
    expect((await rcListDnsRecords(DOMAIN, CUST)).kind).toBe("hard_failure");
  });

  it("skips RC's count keys and maps its field names", async () => {
    const { rcListDnsRecords } = await load(CREDS);
    stubSequence([{ body: {
      recsonpage: 2, recsindb: 2,
      "1": { type: "MX", host: "acmecorp.com", value: "mail.acmecorp.com", timetolive: 7200, recordid: "5", priority: 10 },
      "2": { type: "MX", host: "acmecorp.com", value: "mail2.acmecorp.com", ttl: 3600, "record-id": "6", priority: 20 },
    } }, { body: NOT_FOUND }]);
    const out = await rcListDnsRecords(DOMAIN, CUST);
    const recs = out.kind === "partial" || out.kind === "listed" ? out.records : [];
    expect(recs.map((r) => [r.providerRecordId, r.priority, r.ttl])).toEqual([["5", 10, 7200], ["6", 20, 3600]]);
  });

  it("queries one call per type — seven, because that is RC's API", async () => {
    const { rcListDnsRecords } = await load(CREDS);
    const spy = stubAll(NOT_FOUND);
    await rcListDnsRecords(DOMAIN, CUST);
    expect(spy).toHaveBeenCalledTimes(7);
    expect(new Set(urls(spy))).toEqual(new Set(["/api/dns/manage/search-records.json"]));
  });
});

describe("the gate", () => {
  it("refuses every write when DOMAIN_REGISTER_LIVE is not 1", async () => {
    const dns = await load(CREDS);
    const spy = stubAll({});
    const add = await dns.rcAddDnsRecord(DOMAIN, CUST, { type: "A", host: "@", value: "203.0.113.10" });
    const mod = await dns.rcModifyDnsRecord(DOMAIN, "5", { type: "A", host: "@", value: "203.0.113.11" });
    const del = await dns.rcDeleteDnsRecord(DOMAIN, "5", { type: "A", host: "@", value: "203.0.113.11" });
    const act = await dns.rcActivateDnsManagement(DOMAIN, "order-1");
    for (const o of [add, mod, del, act]) expect(o.kind).toBe("refused");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("records RC would accept but that would be wrong", () => {
  it("refuses an MX with no priority — dns_records refuses it too", async () => {
    const { rcAddDnsRecord } = await load(LIVE);
    const spy = stubAll({});
    const out = await rcAddDnsRecord(DOMAIN, CUST, { type: "MX", host: "@", value: "mail.acmecorp.com" });
    expect(out.kind).toBe("refused");
    expect(out.kind === "refused" && out.reason).toMatch(/priority/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses an SRV without weight and port instead of inventing 10 and 443", async () => {
    const { rcAddDnsRecord } = await load(LIVE);
    const spy = stubAll({});
    const out = await rcAddDnsRecord(DOMAIN, CUST, { type: "SRV", host: "_sip._tcp", value: "sip.acmecorp.com", priority: 10 });
    expect(out.kind).toBe("refused");
    expect(out.kind === "refused" && out.reason).toMatch(/weight/);
    expect(out.kind === "refused" && out.reason).toMatch(/port/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("sends all three when an SRV has them", async () => {
    const { rcAddDnsRecord } = await load(LIVE);
    const spy = stubAll(12);
    const out = await rcAddDnsRecord(DOMAIN, CUST, {
      type: "SRV", host: "_sip._tcp", value: "sip.acmecorp.com", priority: 5, weight: 20, port: 5060,
    });
    expect(out.kind).toBe("done");
    const p = paramsOf(spy, 0);
    expect([p.get("priority"), p.get("weight"), p.get("port")]).toEqual(["5", "20", "5060"]);
  });

  it("refuses a record with no value", async () => {
    const { rcAddDnsRecord } = await load(LIVE);
    const spy = stubAll({});
    expect((await rcAddDnsRecord(DOMAIN, CUST, { type: "A", host: "@", value: "  " })).kind).toBe("refused");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("what goes on the wire", () => {
  it("picks the per-type endpoint", async () => {
    const dns = await load(LIVE);
    const spy = stubAll(1);
    await dns.rcAddDnsRecord(DOMAIN, CUST, { type: "A", host: "@", value: "203.0.113.10" });
    await dns.rcAddDnsRecord(DOMAIN, CUST, { type: "CNAME", host: "www", value: "acmecorp.com." });
    await dns.rcAddDnsRecord(DOMAIN, CUST, { type: "TXT", host: "@", value: "v=spf1 -all" });
    expect(urls(spy)).toEqual([
      "/api/dns/manage/add-ipv4-record.json",
      "/api/dns/manage/add-cname-record.json",
      "/api/dns/manage/add-txt-record.json",
    ]);
  });

  it("turns the apex '@' into the domain name, and leaves a subdomain alone", async () => {
    const dns = await load(LIVE);
    const spy = stubAll(1);
    await dns.rcAddDnsRecord(DOMAIN, CUST, { type: "A", host: "@", value: "203.0.113.10" });
    await dns.rcAddDnsRecord(DOMAIN, CUST, { type: "A", host: "www", value: "203.0.113.10" });
    expect(paramsOf(spy, 0).get("host")).toBe("acmecorp.com");
    expect(paramsOf(spy, 1).get("host")).toBe("www");
  });

  it("clamps a TTL below RC's floor and REPORTS the value it used", async () => {
    const { rcAddDnsRecord } = await load(LIVE);
    const spy = stubAll(1);
    const out = await rcAddDnsRecord(DOMAIN, CUST, { type: "A", host: "@", value: "203.0.113.10", ttl: 300 });
    expect(paramsOf(spy, 0).get("ttl")).toBe("7200");
    expect(out.kind === "done" && out.ttlUsed).toBe(7200);
  });

  it("keeps a TTL above the floor", async () => {
    const { rcAddDnsRecord } = await load(LIVE);
    const spy = stubAll(1);
    await rcAddDnsRecord(DOMAIN, CUST, { type: "A", host: "@", value: "203.0.113.10", ttl: 86400 });
    expect(paramsOf(spy, 0).get("ttl")).toBe("86400");
  });

  it("never sends the string 'undefined' as a priority", async () => {
    /* DMS passed `priority: undefined` and relied on axios dropping it. */
    const { rcModifyDnsRecord } = await load(LIVE);
    const spy = stubAll(1);
    await rcModifyDnsRecord(DOMAIN, "5", { type: "A", host: "@", value: "203.0.113.10" });
    expect(paramsOf(spy, 0).has("priority")).toBe(false);
    expect(String(spy.mock.calls[0][0])).not.toContain("undefined");
  });
});

describe("RC saying no", () => {
  it("an in-body ERROR on HTTP 200 is a failure, not a success", async () => {
    const { rcAddDnsRecord } = await load(LIVE);
    stubAll({ status: "ERROR", message: "Invalid IPv4 address" });
    const out = await rcAddDnsRecord(DOMAIN, CUST, { type: "A", host: "@", value: "not-an-ip" });
    expect(out.kind).toBe("hard_failure");
    expect(out.kind === "hard_failure" && out.reason).toMatch(/Invalid IPv4/);
  });

  it("returns RC's new record id from a bare scalar", async () => {
    const { rcAddDnsRecord } = await load(LIVE);
    stubAll(998877);
    const out = await rcAddDnsRecord(DOMAIN, CUST, { type: "A", host: "@", value: "203.0.113.10" });
    expect(out).toMatchObject({ kind: "done", providerRecordId: "998877" });
  });

  it("a modify with no record id is refused before anything is sent", async () => {
    const { rcModifyDnsRecord } = await load(LIVE);
    const spy = stubAll(1);
    expect((await rcModifyDnsRecord(DOMAIN, "  ", { type: "A", host: "@", value: "1.2.3.4" })).kind).toBe("refused");
    expect(spy).not.toHaveBeenCalled();
  });

  it("deleting a record that is already gone is done, not a failure", async () => {
    const { rcDeleteDnsRecord } = await load(LIVE);
    stubAll({ status: "ERROR", message: "No such record found" });
    const out = await rcDeleteDnsRecord(DOMAIN, "5", { type: "A", host: "@", value: "1.2.3.4" });
    expect(out.kind).toBe("done");
  });

  it("activating DNS that is already active is done, not a failure", async () => {
    const { rcActivateDnsManagement } = await load(LIVE);
    stubAll({ status: "ERROR", message: "DNS is already active for this domain" });
    expect((await rcActivateDnsManagement(DOMAIN, "order-1")).kind).toBe("done");
  });

  it("but a real activation refusal IS a failure", async () => {
    const { rcActivateDnsManagement } = await load(LIVE);
    stubAll({ status: "ERROR", message: "Order not found" });
    expect((await rcActivateDnsManagement(DOMAIN, "order-1")).kind).toBe("hard_failure");
  });
});
