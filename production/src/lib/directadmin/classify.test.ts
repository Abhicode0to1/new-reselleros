import { describe, it, expect } from "vitest";
import {
  classifyDaFailure,
  matchesAny,
  USER_NOT_FOUND_FRAGMENTS,
  PACKAGE_NOT_FOUND_FRAGMENTS,
  USERNAME_TAKEN_FRAGMENTS,
  type DaFailureInput,
} from "./classify";
import { envelopeReason, isErrorEnvelope, isLoginPage } from "./admin-request";

/**
 * The question this module answers is "retry, or give up, or go fix the config",
 * and every wrong answer is expensive in a different way: retrying a permanent
 * failure forever, or marking a live account orphaned because DA was slow for a
 * minute.
 */

const envelope = (reason: string): DaFailureInput => ({ reason, transport: "envelope", status: 200 });
const http = (status: number): DaFailureInput => ({ reason: `HTTP ${status}`, transport: "http", status });

describe("transport decides before wording does", () => {
  it("treats an unreached DA as retryable, whatever it would have said", () => {
    const v = classifyDaFailure("getUserConfig", { reason: "Could not reach DirectAdmin.", transport: "network" });
    expect(v.kind).toBe("unreachable");
  });

  it("treats 502, 503 and 504 as the same backend outage", () => {
    /* DMS matched 503 alone, so a 502 or 504 became a permanent `hard` failure
       and the sweep marked real accounts as gone. */
    for (const status of [502, 503, 504]) {
      expect(classifyDaFailure("op", http(status)).kind).toBe("unreachable");
    }
  });

  it("does not treat a 400 or a 404 as retryable", () => {
    for (const status of [400, 401, 404, 500]) {
      expect(classifyDaFailure("op", http(status)).kind).toBe("hard");
    }
  });

  it("calls the login page a config problem, not a fact about the account", () => {
    /* DA's HTML contains none of the fragments, so DMS filed this under `hard`
       with the HTML as the reason — and the fix is an IP allowlist entry, nowhere
       near the account being swept. */
    const v = classifyDaFailure("listUsers", {
      reason: "DirectAdmin returned its login page",
      transport: "login_page",
      status: 200,
    });
    expect(v.kind).toBe("not_authorised");
  });
});

describe("reading DA's English, which is the only evidence there is", () => {
  it("recognises every not-found wording DMS collected from production", () => {
    for (const fragment of USER_NOT_FOUND_FRAGMENTS) {
      const v = classifyDaFailure("suspend", envelope(`Unable to modify user — ${fragment} 'acme1'`), ["user_not_found"]);
      expect(v.kind, fragment).toBe("user_not_found");
    }
  });

  it("recognises the package wordings", () => {
    for (const fragment of PACKAGE_NOT_FOUND_FRAGMENTS) {
      const v = classifyDaFailure("changePackage", envelope(`Error — ${fragment}`), ["package_not_found"]);
      expect(v.kind, fragment).toBe("package_not_found");
    }
  });

  it("matches case-insensitively, because DA's casing is not stable", () => {
    expect(classifyDaFailure("op", envelope("UNABLE TO FIND USER"), ["user_not_found"]).kind).toBe("user_not_found");
  });

  it("puts an unrecognised refusal in `hard` rather than guessing", () => {
    /* The fragment lists are deliberately conservative: a missing entry must make
       the failure LOUD, not quietly sort it into the wrong bucket. */
    const v = classifyDaFailure("op", envelope("You have no available IPs"), ["user_not_found", "package_not_found"]);
    expect(v.kind).toBe("hard");
    expect(v.reason).toBe("You have no available IPs");
  });

  it("carries DA's own words through, so a log line says something", () => {
    expect(classifyDaFailure("op", envelope("Unable to find user acme1")).reason).toBe("Unable to find user acme1");
  });

  it("synthesises a reason naming the operation when DA sent none", () => {
    expect(classifyDaFailure("changePackage", { reason: "", transport: "envelope" }).reason).toBe(
      "DA changePackage failed",
    );
  });
});

describe("precedence — the order is load-bearing", () => {
  it("reports the USER as missing when DA names both problems", () => {
    /* DA returns both fragments in one response when the username is the wrong
       part. Reporting "no such package" there sends whoever reads it to fix the
       package list, which is not broken. DMS documented this; it is kept. */
    const v = classifyDaFailure(
      "changePackage",
      envelope("Unable to find user acme1 — package does not exist"),
      ["user_not_found", "package_not_found"],
    );
    expect(v.kind).toBe("user_not_found");
  });
});

describe("`consider` keeps an operation from returning a kind it cannot have", () => {
  it("will not report a package problem for a suspend", () => {
    /* A suspend has no package argument, so `package_not_found` there would be a
       claim about something the call never mentioned. */
    const v = classifyDaFailure("suspend", envelope("package does not exist"), ["user_not_found"]);
    expect(v.kind).toBe("hard");
  });

  it("will not report a collision for anything but a create", () => {
    expect(classifyDaFailure("changePackage", envelope("already exists"), ["user_not_found"]).kind).toBe("hard");
    expect(classifyDaFailure("create", envelope("already exists"), ["username_taken"]).kind).toBe("username_taken");
    expect(USERNAME_TAKEN_FRAGMENTS).toContain("already exists");
  });

  it("considers user_not_found by default, since every user-scoped op can hit it", () => {
    expect(classifyDaFailure("op", envelope("no such user")).kind).toBe("user_not_found");
  });
});

describe("matchesAny", () => {
  it("is a lowercased substring match, and safe on nothing", () => {
    expect(matchesAny("Unable To Find User", ["unable to find user"])).toBe(true);
    expect(matchesAny(undefined, ["x"])).toBe(false);
    expect(matchesAny("", ["x"])).toBe(false);
    expect(matchesAny("anything", [])).toBe(false);
  });
});

describe("the envelope DA answers every refusal with", () => {
  it("is recognised only as a whole field, not as a substring", () => {
    expect(isErrorEnvelope("error=1&text=nope")).toBe(true);
    expect(isErrorEnvelope("text=nope&error=1")).toBe(true);
    expect(isErrorEnvelope("error=0&text=ok")).toBe(false);
    /* `error=10` and a value ending in `error=1` must not read as a refusal. */
    expect(isErrorEnvelope("error=10&text=ok")).toBe(false);
    expect(isErrorEnvelope("list[]=myerror=1")).toBe(false);
  });

  it("joins text and details, because `text` alone says nothing useful", () => {
    const raw = "error=1&text=Unable%20to%20modify%20user&details=Package%20does%20not%20exist";
    expect(envelopeReason(raw)).toBe("Unable to modify user — Package does not exist");
  });

  it("decodes DA's plus-for-space form", () => {
    expect(envelopeReason("error=1&text=Unable+to+find+user&details=acme1")).toBe("Unable to find user — acme1");
  });

  it("still says something when DA sent an empty envelope", () => {
    expect(envelopeReason("error=1")).toBe("DirectAdmin refused the request.");
  });

  it("spots the HTML login page", () => {
    expect(isLoginPage("<!DOCTYPE html><html>…")).toBe(true);
    expect(isLoginPage("  <html>")).toBe(true);
    expect(isLoginPage("error=1&text=no")).toBe(false);
  });
});
