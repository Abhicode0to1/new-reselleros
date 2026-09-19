/**
 * `rcDomainDetails` must ask for the order id FIRST. Proven against the live API.
 *
 * ─── THE BUG THESE TESTS PIN ────────────────────────────────────────────────
 * ResellerClub's `details.json` does not accept a domain name. Measured on
 * 11 Sep 2026, the first day this app had real credentials, against
 * `anutechpvtltd.co.in` — a domain the reseller genuinely owns:
 *
 *   details.json?domain-name=…  → HTTP 500
 *                                 {"status":"ERROR",
 *                                  "message":"Required parameter missing: order-id"}
 *   orderid.json?domain-name=…  → HTTP 200  122709027      (a BARE number)
 *   details.json?order-id=…     → HTTP 200  {full details}
 *
 * So the function had never worked, for any domain, ever. Nothing noticed
 * because nothing had credentials: `asset-sweep` marked every domain
 * "unreadable" and carried on, which is exactly what it does when ResellerClub
 * is unreachable. The bug and an outage produced the same sentence.
 *
 * Three separate things had to be true for it to work, and each has its own test
 * below, because each was independently broken:
 *
 *   1. ask `orderid.json` first, then `details.json` BY ORDER-ID
 *   2. accept a bare scalar body (`allowScalar`) — `122709027` is valid JSON, so
 *      it parses to a NUMBER and is not a record
 *   3. read the scalar from `value`, which is the key `call.ts` wraps it under
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ENV_KEYS = ["RESELLERCLUB_API_URL", "RESELLERCLUB_RESELLER_ID", "RESELLERCLUB_API_KEY"] as const;
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
  vi.resetModules();
});

async function load() {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    RESELLERCLUB_API_URL: "https://httpapi.test",
    RESELLERCLUB_RESELLER_ID: "123456",
    RESELLERCLUB_API_KEY: "key",
  });
  vi.resetModules();
  return import("./orders");
}

/** One queued response per fetch call, in order. */
function stubSequence(responses: Array<{ body: unknown; status?: number }>) {
  let i = 0;
  const spy = vi.fn(async () => {
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const pathsOf = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls.map((c) => new URL(String(c[0])).pathname);
const paramsOf = (spy: ReturnType<typeof vi.fn>, i: number) =>
  new URL(String(spy.mock.calls[i][0])).searchParams;

/** RC's real details payload, trimmed to what we read. */
const DETAILS = {
  orderid: "122709027",
  domainname: "anutechpvtltd.co.in",
  currentstatus: "Active",
  endtime: "1791052199",
  ns1: "ns1.anutech.in",
  ns2: "ns2.anutech.in",
  isprivacyprotected: "false",
};

describe("rcDomainDetails — two calls, in the right order", () => {
  it("asks orderid.json by name, THEN details.json by order-id", async () => {
    const { rcDomainDetails } = await load();
    /* The bare number is what RC really sends. Deliberately not `{"orderid":…}`:
       that shape would pass even with the old code. */
    const spy = stubSequence([{ body: "122709027" }, { body: DETAILS }]);

    const out = await rcDomainDetails("anutechpvtltd.co.in");

    expect(pathsOf(spy)).toEqual(["/api/domains/orderid.json", "/api/domains/details.json"]);
    /* The first call carries the NAME. */
    expect(paramsOf(spy, 0).get("domain-name")).toBe("anutechpvtltd.co.in");
    /* The second carries the ORDER-ID and no name — sending a name is what RC
       rejects with "Required parameter missing: order-id". */
    expect(paramsOf(spy, 1).get("order-id")).toBe("122709027");
    expect(paramsOf(spy, 1).get("domain-name")).toBeNull();

    expect(out.kind).toBe("found");
    if (out.kind === "found") {
      expect(out.value.orderId).toBe("122709027");
      expect(out.value.domainName).toBe("anutechpvtltd.co.in");
      expect(out.value.expiryEpochSeconds).toBe(1791052199);
      expect(out.value.nameservers).toEqual(["ns1.anutech.in", "ns2.anutech.in"]);
    }
  });

  it("lower-cases and trims the name it looks up", async () => {
    const { rcDomainDetails } = await load();
    const spy = stubSequence([{ body: "122709027" }, { body: DETAILS }]);
    await rcDomainDetails("  ANUTECHpvtltd.CO.IN  ");
    expect(paramsOf(spy, 0).get("domain-name")).toBe("anutechpvtltd.co.in");
  });

  /* The order id is known from the first call, so a details payload that omits
     the echo must not be discarded. Without the fallback the whole lookup
     returned not_found for a domain we had just found. */
  it("keeps the order id even when details.json does not echo it", async () => {
    const { rcDomainDetails } = await load();
    const withoutEcho = { ...DETAILS } as Record<string, unknown>;
    delete withoutEcho.orderid;
    stubSequence([{ body: "122709027" }, { body: withoutEcho }]);

    const out = await rcDomainDetails("anutechpvtltd.co.in");
    expect(out.kind).toBe("found");
    if (out.kind === "found") expect(out.value.orderId).toBe("122709027");
  });

  it("never calls details.json when the order id cannot be found", async () => {
    const { rcDomainDetails } = await load();
    const spy = stubSequence([
      { body: { status: "ERROR", message: "Website doesn't exist for nope.in" }, status: 500 },
    ]);

    const out = await rcDomainDetails("nope.in");
    /* One call only. Asking for details we cannot address would be a guaranteed
       500 and a misleading error in the log. */
    expect(pathsOf(spy)).toEqual(["/api/domains/orderid.json"]);
    expect(out.kind).toBe("not_found");
  });
});

describe("rcOrderIdFor — the bare-scalar body", () => {
  it("reads a bare number, which is what RC actually sends", async () => {
    const { rcOrderIdFor } = await load();
    stubSequence([{ body: "122709027" }]);
    const out = await rcOrderIdFor("anutechpvtltd.co.in");
    expect(out.kind).toBe("found");
    if (out.kind === "found") expect(out.value).toBe("122709027");
  });

  it("also reads an object body, if RC ever changes shape", async () => {
    const { rcOrderIdFor } = await load();
    stubSequence([{ body: { orderid: "999" } }]);
    const out = await rcOrderIdFor("x.in");
    expect(out.kind === "found" && out.value).toBe("999");
  });

  /* ─── "not ours" IS NOT "ResellerClub is down" ────────────────────────────
     RC's real wording is "Website doesn't exist for …" — a contraction, which
     the not-found fragment list did not cover, so a domain simply not on this
     reseller account classified as a hard_failure. asset-sweep treats those two
     very differently: one is `unclaimed_upstream` (a signal for a person), the
     other is an outage it backs off from. */
  it("classifies RC's real not-found wording as not_found", async () => {
    const { rcOrderIdFor } = await load();
    stubSequence([
      { body: { status: "ERROR", message: "Website doesn't exist for anutech.in" }, status: 500 },
    ]);
    const out = await rcOrderIdFor("anutech.in");
    expect(out.kind).toBe("not_found");
  });

  it("still calls a real outage a hard_failure", async () => {
    const { rcOrderIdFor } = await load();
    stubSequence([{ body: { status: "ERROR", message: "Internal Server Error" }, status: 500 }]);
    const out = await rcOrderIdFor("anutech.in");
    expect(out.kind).toBe("hard_failure");
  });

  /* ─── TWO KINDS OF NONSENSE, AND THEY ARE NOT THE SAME ANSWER ────────────
     An order id is what a renewal is filed against, so neither may be passed on
     as `found`. But they must not be flattened into one kind either, and the
     first version of this test asserted the wrong one.

     A body that is not JSON at all means we do not understand the server —
     `hard_failure`, which is retryable and reads as an outage. A body that
     parses fine but is not an id means the server answered and the field was not
     there — `not_found`, which is a fact about this domain. asset-sweep acts on
     that difference: one backs off, the other is a signal for a person. */
  it("calls an unparseable body a hard_failure, not a missing domain", async () => {
    const { rcOrderIdFor } = await load();
    /* `not-an-id` is not valid JSON, so there is nothing to read. */
    stubSequence([{ body: "not-an-id" }]);
    const out = await rcOrderIdFor("x.in");
    expect(out.kind).toBe("hard_failure");
  });

  it("calls a parseable non-id not_found, and never returns it as an id", async () => {
    const { rcOrderIdFor } = await load();
    /* Valid JSON, a string, and not a number. */
    stubSequence([{ body: JSON.stringify("abc") }]);
    const out = await rcOrderIdFor("x.in");
    expect(out.kind).toBe("not_found");
  });
});
