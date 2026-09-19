import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseDaBool,
  parseUserConfig,
  parseDaList,
  looksLikeHostname,
  ownerFrom,
} from "./accounts";
import { normalizePackageName, isPackageName } from "./provision";

/**
 * The parsers first, then the three-state ownership check — which is the whole
 * reason this module exists rather than being DMS's `domainExists`.
 */

describe("parseDaBool — DA's yes/no, and why the string will not do", () => {
  it("reads yes and no", () => {
    expect(parseDaBool("yes")).toBe(true);
    expect(parseDaBool("no")).toBe(false);
    expect(parseDaBool("ON")).toBe(true);
    expect(parseDaBool("0")).toBe(false);
  });

  it("stays NULL when DA said nothing, rather than becoming false", () => {
    /* "DA did not tell us" and "DA said not suspended" are different answers and
       only one of them is safe to act on. */
    expect(parseDaBool(undefined)).toBeNull();
    expect(parseDaBool("")).toBeNull();
    expect(parseDaBool("maybe")).toBeNull();
  });
});

describe("parseUserConfig", () => {
  const raw = {
    username: "acmecorp1",
    email: "ops@acme.com",
    package: "Standard",
    domain: "acme.com",
    ip: "203.0.113.10",
    suspended: "no",
    creator: "admin",
    date_created: "Mon Sep  1 10:04:11 2026",
    quota: "10000",
  };

  it("names the fields callers actually use", () => {
    const c = parseUserConfig("acmecorp1", raw);
    expect(c.package).toBe("Standard");
    expect(c.domain).toBe("acme.com");
    expect(c.creator).toBe("admin");
    expect(c.dateCreated).toBe("Mon Sep  1 10:04:11 2026");
  });

  it("turns `suspended: 'no'` into FALSE — the defect this fixes", () => {
    /* DMS handed back DA's raw map, so `if (config.suspended)` read every healthy
       account as suspended: "no" is a truthy string. */
    const c = parseUserConfig("acmecorp1", raw);
    expect(c.suspended).toBe(false);
    expect(parseUserConfig("x", { ...raw, suspended: "yes" }).suspended).toBe(true);
  });

  it("keeps the raw map, so nothing is lost by naming a subset", () => {
    expect(parseUserConfig("acmecorp1", raw).raw.quota).toBe("10000");
  });

  it("falls back to the username asked about when DA omits it", () => {
    expect(parseUserConfig("acmecorp1", { package: "Starter" }).username).toBe("acmecorp1");
  });

  it("reports an absent field as null, not as an empty string", () => {
    const c = parseUserConfig("acmecorp1", { username: "acmecorp1", email: "   " });
    expect(c.email).toBeNull();
    expect(c.package).toBeNull();
    expect(c.suspended).toBeNull();
  });
});

describe("parseDaList — three response shapes, one of which is dangerous to miss", () => {
  it("reads DA's usual list[] form", () => {
    expect(parseDaList({ "list[]": ["acme.com", "acme.in"] })).toEqual(["acme.com", "acme.in"]);
  });

  it("reads a single-value list, which parseDA collapses to a scalar", () => {
    expect(parseDaList({ "list[]": "acme.com" })).toEqual(["acme.com"]);
    expect(parseDaList({ list: "acme.com" })).toEqual(["acme.com"]);
  });

  it("falls back to the keys, because some versions answer that way", () => {
    expect(parseDaList({ "acme.com": "acmecorp1", "acme.in": "acmecorp1" }, { hostnames: true })).toEqual([
      "acme.com",
      "acme.in",
    ]);
  });

  it("does not invent domains out of metadata keys", () => {
    /* DMS's fallback took any key containing a dot, having excluded only
       error/text/details — so a version or quota field could become a domain. */
    const got = parseDaList(
      { "acme.com": "acmecorp1", "version": "1.68.2", "bandwidth": "1000.5", "text": "ok" },
      { hostnames: true },
    );
    expect(got).toEqual(["acme.com"]);
  });

  it("keeps usernames, which are not hostnames, when the caller says so", () => {
    expect(parseDaList({ acmecorp1: "", bobshop2: "" })).toEqual(["acmecorp1", "bobshop2"]);
  });

  it("returns an empty list for an empty response, and says nothing more", () => {
    expect(parseDaList({})).toEqual([]);
    expect(parseDaList({ "list[]": "" })).toEqual([]);
  });
});

describe("looksLikeHostname", () => {
  it("accepts real domains and rejects the things that are not one", () => {
    for (const good of ["acme.com", "a.co", "sub.acme.co.uk", "xn--80ak6aa92e.com", "my-shop.in"]) {
      expect(looksLikeHostname(good), good).toBe(true);
    }
    for (const bad of ["acme", "", "-acme.com", "acme..com", "acme.com/path", "ac me.com", "acme.com=user"]) {
      expect(looksLikeHostname(bad), bad).toBe(false);
    }
  });
});

describe("ownerFrom", () => {
  it("reads DA's domain=username form", () => {
    expect(ownerFrom("acme.com", { "acme.com": "acmecorp1" })).toBe("acmecorp1");
  });

  it("is case-insensitive about the domain asked for", () => {
    expect(ownerFrom("ACME.com", { "acme.com": "acmecorp1" })).toBe("acmecorp1");
  });

  it("reads the list form some versions answer with", () => {
    expect(ownerFrom("acme.in", { "list[]": ["acme.com=acmecorp1", "acme.in=bobshop2"] })).toBe("bobshop2");
  });

  it("reports null rather than picking a neighbouring domain's owner", () => {
    expect(ownerFrom("other.com", { "acme.com": "acmecorp1" })).toBeNull();
    expect(ownerFrom("acme.com", {})).toBeNull();
  });
});

describe("package names", () => {
  it("case-corrects only against names the server really has", () => {
    /* DMS corrected against a compile-time list, which is right until somebody
       renames a package on the server and it silently sends the old name. */
    expect(normalizePackageName("standard", ["Starter", "Standard"])).toBe("Standard");
    expect(normalizePackageName("Standard", ["Starter", "Standard"])).toBe("Standard");
    /* Not on the server: passed through untouched, so DA gets to refuse it and
       say so, rather than this guessing a correction. */
    expect(normalizePackageName("Gold", ["Starter", "Standard"])).toBe("Gold");
    /* No list given: corrects nothing. */
    expect(normalizePackageName("standard")).toBe("standard");
  });

  it("rejects a name that could carry more than a name", () => {
    expect(isPackageName("Standard")).toBe(true);
    expect(isPackageName("plan_2026-b")).toBe(true);
    for (const bad of ["", "a b", "Standard&user=admin", "../../etc", "x".repeat(65)]) {
      expect(isPackageName(bad), bad).toBe(false);
    }
  });
});

/* ── The three-state ownership check ─────────────────────────────────────────
 *
 * Driven through a stubbed fetch because the distinction it exists for is
 * between two things that both come back from the network, and a parser test
 * cannot show it.
 */
describe("daDomainOwner — a failed check is NOT a free domain", () => {
  const ORIGINAL = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv("DIRECTADMIN_URL", "https://da.example.test:2222");
    vi.stubEnv("DIRECTADMIN_ADMIN_USER", "admin");
    vi.stubEnv("DIRECTADMIN_API_KEY", "test-key");
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL;
    vi.unstubAllEnvs();
  });

  /** Env is read into module constants at import, so the import must come after. */
  async function withResponse(reply: Response | Error) {
    globalThis.fetch = vi.fn(async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    }) as unknown as typeof fetch;
    return import("./accounts");
  }

  it("reports the owner DA names", async () => {
    const { daDomainOwner } = await withResponse(new Response("acme.com=acmecorp1", { status: 200 }));
    expect(await daDomainOwner("acme.com")).toEqual({ kind: "owned", username: "acmecorp1" });
  });

  it("reports UNOWNED when DA answered and said it has no such domain", async () => {
    /* DA's error envelope on this endpoint IS the not-found answer — it
       understood the question. */
    const { daDomainOwner } = await withResponse(
      new Response("error=1&text=Domain+not+found", { status: 200 }),
    );
    expect(await daDomainOwner("acme.com")).toEqual({ kind: "unowned" });
  });

  it("reports UNKNOWN when DA could not be reached — the fixed defect", async () => {
    /* DMS returned false here, and its own comment said the point was "to allow
       purchase attempt". False means "nothing here, go ahead and create it", so a
       DA blip could aim a provisioning run at a domain somebody else is hosting. */
    const { daDomainOwner } = await withResponse(new Error("ETIMEDOUT"));
    const out = await daDomainOwner("acme.com");
    expect(out.kind).toBe("unknown");
    expect(out.kind === "unknown" && out.reason).toBeTruthy();
  });

  it("reports UNKNOWN on a 503, not a free domain", async () => {
    const { daDomainOwner } = await withResponse(new Response("busy", { status: 503 }));
    expect((await daDomainOwner("acme.com")).kind).toBe("unknown");
  });

  it("reports UNKNOWN when DA hands back its login page", async () => {
    /* An IP that is not on the allowlist gets HTML with a 200. Reading that as
       "no such domain" would be the same collision by a different route. */
    const { daDomainOwner } = await withResponse(new Response("<!DOCTYPE html><html>login", { status: 200 }));
    expect((await daDomainOwner("acme.com")).kind).toBe("unknown");
  });

  it("sends nothing at all for something that is not a domain", async () => {
    const { daDomainOwner } = await withResponse(new Response("", { status: 200 }));
    expect((await daDomainOwner("not a domain")).kind).toBe("unknown");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("the reads refuse before sending when they cannot succeed", () => {
  const ORIGINAL = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = ORIGINAL;
    vi.unstubAllEnvs();
  });

  it("sends no request when DirectAdmin is not configured", async () => {
    vi.stubEnv("DIRECTADMIN_URL", "");
    vi.stubEnv("DIRECTADMIN_ADMIN_USER", "");
    vi.stubEnv("DIRECTADMIN_API_KEY", "");
    vi.resetModules();
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const { daUserConfig, daListUsers, daUserDomains } = await import("./accounts");
    expect((await daUserConfig("acmecorp1")).kind).toBe("refused");
    expect((await daListUsers()).kind).toBe("refused");
    expect((await daUserDomains("acmecorp1")).kind).toBe("refused");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("sends no request for a username that is not one", async () => {
    vi.stubEnv("DIRECTADMIN_URL", "https://da.example.test:2222");
    vi.stubEnv("DIRECTADMIN_ADMIN_USER", "admin");
    vi.stubEnv("DIRECTADMIN_API_KEY", "test-key");
    vi.resetModules();
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const { daUserConfig } = await import("./accounts");
    /* A `|` would change which account DA acts as; it never reaches the wire. */
    expect((await daUserConfig("admin|root")).kind).toBe("refused");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("a failed list read is never an empty list", () => {
  const ORIGINAL = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv("DIRECTADMIN_URL", "https://da.example.test:2222");
    vi.stubEnv("DIRECTADMIN_ADMIN_USER", "admin");
    vi.stubEnv("DIRECTADMIN_API_KEY", "test-key");
    vi.resetModules();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL;
    vi.unstubAllEnvs();
  });

  async function listUsersWith(reply: Response | Error) {
    globalThis.fetch = vi.fn(async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    }) as unknown as typeof fetch;
    const { daListUsers } = await import("./accounts");
    return daListUsers();
  }

  it("says `unreachable`, not `listed: []`, when DA is down", async () => {
    /* This is the distinction the whole module is shaped around: anything
       reconciling against `[]` deletes what it cannot currently see. */
    const out = await listUsersWith(new Error("ECONNREFUSED"));
    expect(out.kind).toBe("unreachable");
  });

  it("says `not_authorised` when the IP is not on DA's allowlist", async () => {
    const out = await listUsersWith(new Response("<html>login</html>", { status: 200 }));
    expect(out.kind).toBe("not_authorised");
  });

  it("says `listed: []` only when DA actually answered with nothing", async () => {
    const out = await listUsersWith(new Response("", { status: 200 }));
    expect(out).toEqual({ kind: "listed", items: [] });
  });

  it("lists what DA sent", async () => {
    const out = await listUsersWith(new Response("list[]=acmecorp1&list[]=bobshop2", { status: 200 }));
    expect(out).toEqual({ kind: "listed", items: ["acmecorp1", "bobshop2"] });
  });
});
