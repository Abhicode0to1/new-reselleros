import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * The registrant identity a domain gets filed under.
 *
 * Two things make this worth testing hard rather than reasoning about:
 *
 *   1. Getting it wrong puts a customer's domain under SOMEBODY ELSE'S RC
 *      account, and the repair is a transfer, not an edit.
 *   2. The module it was ported from had a defect that did exactly that — a
 *      failed lookup was read as "no such customer", so a timeout created a
 *      duplicate. Most of what follows exists to hold that shut.
 *
 * Same harness shape as orders.test.ts, and for the same reason: call.ts reads
 * credentials into module constants at import time, so changing the environment
 * means re-importing. Nothing here touches the network.
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
  vi.restoreAllMocks();
});

async function load(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  return import("./customers");
}

const CREDS = { RESELLERCLUB_RESELLER_ID: "123456", RESELLERCLUB_API_KEY: "test-key" } as const;
const LIVE = { ...CREDS, DOMAIN_REGISTER_LIVE: "1" } as const;

const REGISTRANT = {
  email: "rajesh@acmecorp.com",
  name: "Rajesh Kumar",
  companyName: "Acme Corp Pvt Ltd",
  phone: "+91 98100 12345",
  address: { line1: "12 MG Road", city: "Gurugram", state: "Haryana", zipcode: "122001" },
};

/** Queue of responses, one per fetch call, in order. */
function stubSequence(responses: Array<{ body: unknown; status?: number } | Error>) {
  let i = 0;
  const spy = vi.fn(async () => {
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

/** Which RC endpoints were hit, in order. */
function paths(spy: ReturnType<typeof vi.fn>): string[] {
  return spy.mock.calls.map((c) => new URL(String(c[0])).pathname);
}

function paramsOf(spy: ReturnType<typeof vi.fn>, callIndex: number): URLSearchParams {
  return new URL(String(spy.mock.calls[callIndex][0])).searchParams;
}

describe("the gate — nothing reaches ResellerClub until both halves are open", () => {
  it("refuses with no credentials, and sends nothing", async () => {
    const { rcEnsureRegistrant } = await load({});
    const spy = stubSequence([{ body: {} }]);
    const out = await rcEnsureRegistrant(REGISTRANT);
    expect(out.kind).toBe("refused");
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses when DOMAIN_REGISTER_LIVE is not 1, even with credentials", async () => {
    const { rcEnsureRegistrant } = await load(CREDS);
    const spy = stubSequence([{ body: {} }]);
    const out = await rcEnsureRegistrant(REGISTRANT);
    expect(out.kind).toBe("refused");
    expect(out.kind === "refused" && out.reason).toMatch(/DOMAIN_REGISTER_LIVE/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("an incomplete registrant is REFUSED, not defaulted — it goes to the registry", () => {
  it("names every missing field instead of saying 'invalid'", async () => {
    const { rcEnsureRegistrant } = await load(LIVE);
    const spy = stubSequence([{ body: {} }]);
    const out = await rcEnsureRegistrant({
      ...REGISTRANT,
      address: { ...REGISTRANT.address, city: "", zipcode: "  " },
    });
    expect(out.kind).toBe("refused");
    expect(out.kind === "refused" && out.reason).toMatch(/address\.city/);
    expect(out.kind === "refused" && out.reason).toMatch(/address\.zipcode/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a phone that is not a phone", async () => {
    const { rcEnsureRegistrant } = await load(LIVE);
    const spy = stubSequence([{ body: {} }]);
    const out = await rcEnsureRegistrant({ ...REGISTRANT, phone: "n/a" });
    expect(out.kind).toBe("refused");
    expect(out.kind === "refused" && out.reason).toMatch(/phone/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does NOT invent an address — no 'Default' anywhere in what it would send", async () => {
    const { rcEnsureRegistrant } = await load(LIVE);
    const spy = stubSequence([{ body: {} }]);
    await rcEnsureRegistrant({ ...REGISTRANT, address: { ...REGISTRANT.address, line1: "" } });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("a lookup that FAILS must never be read as 'no such customer' — the ported defect", () => {
  it("does not create a customer when the lookup is unreachable", async () => {
    const { rcEnsureRegistrant } = await load(LIVE);
    const spy = stubSequence([new Error("ETIMEDOUT")]);
    const out = await rcEnsureRegistrant(REGISTRANT);
    expect(out.kind).toBe("hard_failure");
    expect(paths(spy)).toEqual(["/api/customers/details.json"]);
    expect(paths(spy)).not.toContain("/api/customers/signup.json");
  });

  it("does not create a customer when RC answers 200 with an in-body ERROR", async () => {
    const { rcEnsureRegistrant } = await load(LIVE);
    const spy = stubSequence([
      { body: { status: "ERROR", message: "IP not whitelisted for API access" } },
    ]);
    const out = await rcEnsureRegistrant(REGISTRANT);
    expect(out.kind).toBe("hard_failure");
    expect(out.kind === "hard_failure" && out.reason).toMatch(/whitelisted/i);
    expect(paths(spy)).not.toContain("/api/customers/signup.json");
  });

  it("says WHY it refused to create — a duplicate would misfile the domain", async () => {
    const { rcEnsureRegistrant } = await load(LIVE);
    stubSequence([{ body: { status: "ERROR", message: "authentication failed" } }]);
    const out = await rcEnsureRegistrant(REGISTRANT);
    expect(out.kind === "hard_failure" && out.reason).toMatch(/wrong account|duplicate/i);
  });

  it("DOES create when RC genuinely says the customer does not exist", async () => {
    const { rcEnsureRegistrant } = await load(LIVE);
    const spy = stubSequence([
      { body: { status: "ERROR", message: "No entity found for entity type customer" } },
      { body: 9001 },
      { body: 7001 },
    ]);
    const out = await rcEnsureRegistrant(REGISTRANT);
    expect(out).toEqual({ kind: "ready", customerId: "9001", contactId: "7001", createdCustomer: true });
    expect(paths(spy)).toEqual([
      "/api/customers/details.json",
      "/api/customers/signup.json",
      "/api/contacts/add.json",
    ]);
  });

  it("reuses an existing customer and never calls signup", async () => {
    const { rcEnsureRegistrant } = await load(LIVE);
    const spy = stubSequence([{ body: { customerid: 4242 } }, { body: 7002 }]);
    const out = await rcEnsureRegistrant(REGISTRANT);
    expect(out).toEqual({ kind: "ready", customerId: "4242", contactId: "7002", createdCustomer: false });
    expect(paths(spy)).not.toContain("/api/customers/signup.json");
  });
});

describe("RC's bare-scalar ids — the transport had to be taught these", () => {
  it("accepts a bare number as the new customer id", async () => {
    const { rcCreateCustomer } = await load(LIVE);
    stubSequence([{ body: 12345 }]);
    await expect(rcCreateCustomer(REGISTRANT)).resolves.toEqual({ kind: "created", id: "12345" });
  });

  it("accepts a bare quoted number too", async () => {
    const { rcCreateContact } = await load(LIVE);
    stubSequence([{ body: '"7777"' }]);
    await expect(rcCreateContact("9001", REGISTRANT)).resolves.toEqual({ kind: "created", id: "7777" });
  });

  it("does not accept a non-numeric body as an id", async () => {
    const { rcCreateCustomer } = await load(LIVE);
    stubSequence([{ body: '"something went wrong"' }]);
    const out = await rcCreateCustomer(REGISTRANT);
    expect(out.kind).toBe("hard_failure");
  });

  it("an accepted signup with no readable id does NOT claim the create failed", async () => {
    /* It may well have been created upstream. The caller must not go and make a
       second one, so the wording is 'no id', not 'not created'. */
    const { rcCreateCustomer } = await load(LIVE);
    stubSequence([{ body: { status: "success" } }]);
    const out = await rcCreateCustomer(REGISTRANT);
    expect(out.kind).toBe("hard_failure");
    expect(out.kind === "hard_failure" && out.reason).toMatch(/returned no customer id/);
  });
});

describe("what actually goes on the wire", () => {
  it("strips the phone to digits and defaults cc 91 / country IN", async () => {
    const { rcCreateCustomer } = await load(LIVE);
    const spy = stubSequence([{ body: 1 }]);
    await rcCreateCustomer(REGISTRANT);
    const p = paramsOf(spy, 0);
    expect(p.get("phone")).toBe("919810012345");
    expect(p.get("phone-cc")).toBe("91");
    expect(p.get("country")).toBe("IN");
  });

  it("sends the company when there is one, and the person's name when there is not", async () => {
    const { rcCreateContact } = await load(LIVE);
    const spy = stubSequence([{ body: 1 }, { body: 1 }]);
    await rcCreateContact("9001", REGISTRANT);
    expect(paramsOf(spy, 0).get("company")).toBe("Acme Corp Pvt Ltd");
    await rcCreateContact("9001", { ...REGISTRANT, companyName: null });
    expect(paramsOf(spy, 1).get("company")).toBe("Rajesh Kumar");
  });

  it("never logs the password it generated", async () => {
    /* The module it was ported from logged `{ password, passwordLength }` at info
       level on every creation. */
    const { rcCreateCustomer } = await load(LIVE);
    const spy = stubSequence([{ body: 1 }]);
    const logs: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
    await rcCreateCustomer(REGISTRANT);
    const sentPassword = paramsOf(spy, 0).get("passwd");
    expect(sentPassword).toBeTruthy();
    expect(sentPassword!.length).toBeGreaterThanOrEqual(8);
    expect(sentPassword!.length).toBeLessThanOrEqual(15);
    expect(logs.join("\n")).not.toContain(sentPassword!);
    expect(logs.join("\n")).not.toMatch(/passwd|password/i);
  });
});

describe("a contact that fails after the customer was created", () => {
  it("names the customer id so a retry reuses it instead of duplicating", async () => {
    const { rcEnsureRegistrant } = await load(LIVE);
    stubSequence([
      { body: { status: "ERROR", message: "not found" } },
      { body: 9009 },
      { body: { status: "ERROR", message: "invalid state for country IN" } },
    ]);
    const out = await rcEnsureRegistrant(REGISTRANT);
    expect(out.kind).toBe("hard_failure");
    expect(out.kind === "hard_failure" && out.reason).toMatch(/9009/);
    expect(out.kind === "hard_failure" && out.reason).toMatch(/reused/);
  });
});

describe("rcCustomerIdFor keeps the three answers apart", () => {
  it("found", async () => {
    const { rcCustomerIdFor } = await load(LIVE);
    stubSequence([{ body: { customerid: "555" } }]);
    await expect(rcCustomerIdFor("a@b.com")).resolves.toEqual({ kind: "found", value: "555" });
  });

  it("not_found, on RC's own words", async () => {
    const { rcCustomerIdFor } = await load(LIVE);
    stubSequence([{ body: { status: "ERROR", message: "No entity found" } }]);
    expect((await rcCustomerIdFor("a@b.com")).kind).toBe("not_found");
  });

  it("hard_failure for anything else — NOT not_found", async () => {
    const { rcCustomerIdFor } = await load(LIVE);
    stubSequence([{ body: { status: "ERROR", message: "api key is invalid" } }]);
    expect((await rcCustomerIdFor("a@b.com")).kind).toBe("hard_failure");
  });
});
