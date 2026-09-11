import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * The gate and the transport. Between them these decide whether real money
 * leaves the reseller account, so both are pinned here.
 *
 * `orders.ts` reads its credentials into module-level constants at import time
 * (so a call site cannot swap them mid-flight), which means a test that wants
 * different credentials has to re-import the module. Hence `vi.resetModules()`
 * and dynamic `import()` throughout rather than a top-level import — the shape
 * is deliberate, not incidental.
 *
 * No test here touches the network: `fetch` is replaced in every case that gets
 * past the gate. A unit test that reached ResellerClub would register a domain.
 */

const ENV_KEYS = [
  "RESELLERCLUB_RESELLER_ID",
  "RESELLERCLUB_API_KEY",
  "RESELLERCLUB_API_URL",
  "DOMAIN_REGISTER_LIVE",
  "RESELLERCLUB_NS_1",
  "RESELLERCLUB_NS_2",
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

/** Import `orders.ts` with a given environment. */
async function load(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  return import("./orders");
}

const CREDS = { RESELLERCLUB_RESELLER_ID: "123456", RESELLERCLUB_API_KEY: "test-key" } as const;
const LIVE = { ...CREDS, DOMAIN_REGISTER_LIVE: "1" } as const;

const REGISTER = {
  domainName: "example-test.in",
  years: 1,
  customerId: "9001",
  contactId: "7001",
};

/** Replace fetch with one that returns this JSON body and status. */
function stubFetch(body: unknown, status = 200) {
  const spy = vi.fn(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

/* ── The gate ───────────────────────────────────────────────────────────────── */

describe("the money gate", () => {
  /* ⚠️ TRUE ONLY UNDER TEST, AND THAT IS THE POINT.
     Until 11 Sep 2026 `DOMAIN_REGISTER_LIVE` was opt-in, so credentials without
     the flag meant "do not order" everywhere. Pardeep then asked for the gate
     to default ON ("keep those turned on by default until admin ask
     otherwise"), so in production credentials alone DO now permit ordering.

     A test run keeps the old opt-in rule, because a unit test must never be
     able to buy a domain — see lib/provisioning/live-gates.ts. This assertion
     is therefore pinning the test-environment carve-out, not the product rule,
     and the production rule is pinned separately below. Reading it as the
     product rule is exactly the mistake this comment exists to prevent. */
  it("credentials alone do NOT permit ordering IN A TEST RUN", async () => {
    const rc = await load(CREDS);
    expect(rc.rcWriteConfigured()).toBe(true);
    expect(rc.rcOrderingEnabled()).toBe(false);
  });

  /* The product rule, pinned by removing the test markers the carve-out keys
     off. If this ever fails, the default silently went back to opt-in and a
     deployment that forgot the flag would sell domains it never orders. */
  it("OUTSIDE a test run, credentials alone DO permit ordering — the new default", async () => {
    const savedNode = process.env.NODE_ENV;
    const savedVitest = process.env.VITEST;
    const savedWorker = process.env.VITEST_WORKER_ID;
    try {
      // @ts-expect-error — NODE_ENV is typed as a literal union
      process.env.NODE_ENV = "production";
      delete process.env.VITEST;
      delete process.env.VITEST_WORKER_ID;
      const rc = await load(CREDS);
      expect(rc.rcOrderingEnabled()).toBe(true);
    } finally {
      // @ts-expect-error — restoring the literal union
      process.env.NODE_ENV = savedNode;
      if (savedVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = savedVitest;
      if (savedWorker === undefined) delete process.env.VITEST_WORKER_ID;
      else process.env.VITEST_WORKER_ID = savedWorker;
    }
  });

  it("the flag alone does not either", async () => {
    const rc = await load({ DOMAIN_REGISTER_LIVE: "1" });
    expect(rc.rcWriteConfigured()).toBe(false);
    expect(rc.rcOrderingEnabled()).toBe(false);
  });

  it("both together open it", async () => {
    const rc = await load(LIVE);
    expect(rc.rcOrderingEnabled()).toBe(true);
  });

  /* ─── THE RISK CHANGED DIRECTION ─────────────────────────────────────────
     This test used to read "only the exact string '1' counts — 'true' and
     'yes' do not open a money gate", which was right while the gate was
     opt-in: a vague value must not be read as permission.

     With the default OPEN the expensive mistake is the mirror image. Somebody
     switching ordering OFF in a hurry writes `false`, or `off`, or `disabled` —
     and under the old `=== "1"` rule every one of those did close it, by
     accident of not being "1". Under a parsed rule they only close it if the
     parser knows them. So what has to be pinned now is that every plausible
     way of writing "off" actually stops an order. */
  it("every plausible spelling of OFF closes the gate", async () => {
    for (const v of ["0", "false", "no", "off", "disabled", "disable", "none", "FALSE", " Off "]) {
      const rc = await load({ ...CREDS, DOMAIN_REGISTER_LIVE: v });
      expect(rc.rcOrderingEnabled(), `${JSON.stringify(v)} should close the gate`).toBe(false);
    }
  });

  it("the on spellings open it, so a reasonable value is not read as off", async () => {
    for (const v of ["1", "true", "yes", "on", "enabled", "live", "TRUE"]) {
      const rc = await load({ ...CREDS, DOMAIN_REGISTER_LIVE: v });
      expect(rc.rcOrderingEnabled(), `${JSON.stringify(v)} should open the gate`).toBe(true);
    }
  });

  /* Unset inside a test run stays shut — the carve-out, checked here beside the
     spellings so the three rules are readable together. */
  it("unset or empty is shut in a test run", async () => {
    for (const v of [undefined, ""]) {
      const rc = await load(v === undefined ? CREDS : { ...CREDS, DOMAIN_REGISTER_LIVE: v });
      expect(rc.rcOrderingEnabled()).toBe(false);
    }
  });

  it("a gated register NEVER reaches the network", async () => {
    const rc = await load(CREDS);
    const spy = stubFetch({ status: "success", orderid: 1 });
    const out = await rc.rcRegisterDomain(REGISTER);
    expect(spy).not.toHaveBeenCalled();
    expect(out.kind).toBe("hard_failure");
    expect(out.kind === "hard_failure" && out.reason).toMatch(/DOMAIN_REGISTER_LIVE/);
  });

  it("the gate says WHICH half is missing, so the operator knows what to fix (§24)", async () => {
    const noCreds = await load({ DOMAIN_REGISTER_LIVE: "1" });
    const a = await noCreds.rcRegisterDomain(REGISTER);
    expect(a.kind === "hard_failure" && a.reason).toMatch(/credentials/);

    const noFlag = await load(CREDS);
    const b = await noFlag.rcRegisterDomain(REGISTER);
    expect(b.kind === "hard_failure" && b.reason).toMatch(/switched off/);
  });

  it("renew and transfer are gated too, not just register", async () => {
    const rc = await load(CREDS);
    const spy = stubFetch({ status: "success" });
    expect((await rc.rcRenewDomain({ orderId: "1", years: 1, expiryEpochSeconds: 1_800_000_000 })).kind).toBe("hard_failure");
    expect((await rc.rcTransferDomain({ domainName: "x.in", authCode: "abc", customerId: "1", contactId: "1" })).kind).toBe("hard_failure");
    expect((await rc.rcModifyNameservers("1", ["a.ns.com", "b.ns.com"])).status).toBe("error");
    expect(spy).not.toHaveBeenCalled();
  });
});

/* ── Input validation, before any spend ─────────────────────────────────────── */

describe("validation refuses before the call, not after", () => {
  it.each([0, 11, 1.5, NaN])("a %s-year registration is refused without calling RC", async (years) => {
    const rc = await load(LIVE);
    const spy = stubFetch({ status: "success", orderid: 1 });
    const out = await rc.rcRegisterDomain({ ...REGISTER, years });
    expect(out.kind).toBe("hard_failure");
    expect(spy).not.toHaveBeenCalled();
  });

  it("a string with no dot is not a domain name", async () => {
    const rc = await load(LIVE);
    const spy = stubFetch({ status: "success", orderid: 1 });
    expect((await rc.rcRegisterDomain({ ...REGISTER, domainName: "notadomain" })).kind).toBe("hard_failure");
    expect(spy).not.toHaveBeenCalled();
  });

  it("A RENEWAL WITHOUT THE CURRENT EXPIRY IS REFUSED — that field is how RC spots a duplicate renewal", async () => {
    const rc = await load(LIVE);
    const spy = stubFetch({ status: "success", orderid: 1 });
    for (const bad of [0, -1, NaN]) {
      const out = await rc.rcRenewDomain({ orderId: "55", years: 1, expiryEpochSeconds: bad });
      expect(out.kind).toBe("hard_failure");
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("a transfer with a blank auth code is a rejection the customer can act on, not a hard failure", async () => {
    const rc = await load(LIVE);
    const out = await rc.rcTransferDomain({ domainName: "x.in", authCode: "   ", customerId: "1", contactId: "1" });
    expect(out.kind).toBe("transfer_rejected");
    expect(out.kind === "transfer_rejected" && out.reason).toMatch(/EPP/);
  });

  it("fewer than two nameservers is refused — one is an outage waiting to happen", async () => {
    const rc = await load(LIVE);
    expect((await rc.rcModifyNameservers("1", ["only.ns.com"])).status).toBe("error");
    expect((await rc.rcModifyNameservers("1", [])).status).toBe("error");
  });
});

/* ── Transport normalisation ────────────────────────────────────────────────── */

describe("rcCall normalisation — the bug the engine has in renew and transfer", () => {
  it("HTTP 200 with an in-body error is an ERROR, not a success", async () => {
    // The engine's renewDomain returns success here, which is how a refused
    // renewal gets recorded as renewed and the domain quietly expires.
    const rc = await load(LIVE);
    stubFetch({ status: "ERROR", message: "Invalid domain name" });
    const out = await rc.rcRenewDomain({ orderId: "55", years: 1, expiryEpochSeconds: 1_800_000_000 });
    expect(out.kind).toBe("hard_failure");
    expect(out.kind === "hard_failure" && out.reason).toBe("Invalid domain name");
  });

  it("the same normalisation applies to transfer", async () => {
    const rc = await load(LIVE);
    stubFetch({ status: "ERROR", message: "Invalid auth code supplied" });
    const out = await rc.rcTransferDomain({ domainName: "x.in", authCode: "abc", customerId: "1", contactId: "1" });
    expect(out.kind).toBe("transfer_rejected");
  });

  it("an { error } body with no status field is still an error", async () => {
    const rc = await load(LIVE);
    stubFetch({ error: "IP not whitelisted" });
    const out = await rc.rcRegisterDomain(REGISTER);
    expect(out.kind).toBe("hard_failure");
    expect(out.kind === "hard_failure" && out.reason).toBe("IP not whitelisted");
  });

  it("'InvoicePaid' is PENDING — the money moved, so a retry would spend it twice", async () => {
    const rc = await load(LIVE);
    stubFetch({ status: "InvoicePaid", message: "invoice paid" });
    const out = await rc.rcRegisterDomain(REGISTER);
    expect(out.kind).toBe("balance_pending");
  });

  it("a non-2xx prefers RC's own reason over the bare status code (§24)", async () => {
    const rc = await load(LIVE);
    stubFetch({ message: "Authentication failed for this IP" }, 403);
    const out = await rc.rcRegisterDomain(REGISTER);
    expect(out.kind).toBe("hard_failure");
    expect(out.kind === "hard_failure" && out.reason).toBe("Authentication failed for this IP");
  });

  it("an unparseable body is an error, never a silent success", async () => {
    const rc = await load(LIVE);
    stubFetch("<html>login page</html>");
    const out = await rc.rcRegisterDomain(REGISTER);
    expect(out.kind).toBe("hard_failure");
  });

  it("a thrown fetch (DNS, timeout) becomes a hard failure and does not escape", async () => {
    const rc = await load(LIVE);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ETIMEDOUT"); }));
    const out = await rc.rcRegisterDomain(REGISTER);
    expect(out.kind).toBe("hard_failure");
    expect(out.kind === "hard_failure" && out.reason).toMatch(/ETIMEDOUT/);
  });

  it("a success carries the order id through", async () => {
    const rc = await load(LIVE);
    stubFetch({ status: "Success", orderid: 778899 });
    const out = await rc.rcRegisterDomain(REGISTER);
    expect(out).toEqual({ kind: "registered", orderId: "778899" });
  });
});

/* ── What actually goes on the wire ─────────────────────────────────────────── */

describe("the request itself", () => {
  async function captureUrl(
    fn: (rc: typeof import("./orders")) => Promise<unknown>,
    env: Partial<Record<(typeof ENV_KEYS)[number], string>> = LIVE,
  ) {
    const rc = await load(env);
    const spy = stubFetch({ status: "success", orderid: 1 });
    await fn(rc);
    expect(spy).toHaveBeenCalledOnce();
    return new URL((spy.mock.calls[0] as unknown as [string])[0]);
  }

  it("credentials go in the query string — RC has no header auth", async () => {
    const url = await captureUrl((rc) => rc.rcRegisterDomain(REGISTER));
    expect(url.searchParams.get("auth-userid")).toBe("123456");
    expect(url.searchParams.get("api-key")).toBe("test-key");
  });

  it("invoice-option is NoInvoice — we bill through our own GST spine, not RC's", async () => {
    const url = await captureUrl((rc) => rc.rcRegisterDomain(REGISTER));
    expect(url.searchParams.get("invoice-option")).toBe("NoInvoice");
  });

  it("all four contact roles are filled, defaulting to the one contact given", async () => {
    const url = await captureUrl((rc) => rc.rcRegisterDomain(REGISTER));
    for (const k of ["reg-contact-id", "admin-contact-id", "tech-contact-id", "billing-contact-id"]) {
      expect(url.searchParams.get(k)).toBe("7001");
    }
  });

  it("a registration always carries nameservers — a parked domain does not resolve", async () => {
    const url = await captureUrl((rc) => rc.rcRegisterDomain(REGISTER));
    expect(url.searchParams.getAll("ns").length).toBeGreaterThanOrEqual(2);
  });

  it("nameservers come from env when set, so they are not baked into the code", async () => {
    const url = await captureUrl(
      (rc) => rc.rcRegisterDomain(REGISTER),
      { ...LIVE, RESELLERCLUB_NS_1: "ns1.anutech.in", RESELLERCLUB_NS_2: "ns2.anutech.in" },
    );
    expect(url.searchParams.getAll("ns")).toEqual(["ns1.anutech.in", "ns2.anutech.in"]);
  });

  it("the domain name is lowercased before it reaches the registrar", async () => {
    const url = await captureUrl((rc) => rc.rcRegisterDomain({ ...REGISTER, domainName: "MiXeD.In" }));
    expect(url.searchParams.get("domain-name")).toBe("mixed.in");
  });

  it("the renewal sends exp-date, and sends it as whole seconds", async () => {
    const url = await captureUrl((rc) =>
      rc.rcRenewDomain({ orderId: "55", years: 2, expiryEpochSeconds: 1_800_000_000.7 }));
    expect(url.searchParams.get("exp-date")).toBe("1800000000");
    expect(url.searchParams.get("years")).toBe("2");
  });
});
