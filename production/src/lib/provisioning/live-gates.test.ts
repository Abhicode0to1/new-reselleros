/**
 * The two switches that permit real spending, after the default was inverted.
 *
 * ─── WHAT CHANGED ───────────────────────────────────────────────────────────
 * Pardeep, 11 Sep 2026: "Keep those turned on by default until admin ask
 * otherwise." `DOMAIN_REGISTER_LIVE` and `HOSTING_TRIAL_LIVE` went from opt-IN
 * (absent = no ordering) to opt-OUT (absent = order).
 *
 * That moves a fail-safe. Every accident that used to produce "buy nothing" — a
 * fresh deployment, a lost config map, a half-written env file — now produces
 * "buy". The business asked for it and it is a reasonable ask; these tests exist
 * because the direction of the failure moved rather than went away.
 *
 * ─── THE ONE RULE THAT MUST NOT ERODE ───────────────────────────────────────
 * A test run never orders. If the open default reached the test environment,
 * ~7,300 tests would each be one accidental credential away from registering a
 * real domain, in the least supervised place in the project. So under test the
 * old opt-in rule still applies, and that is pinned harder than anything else
 * in this file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  liveGateOpen,
  liveGateDiagnostic,
  domainOrderingAllowed,
  hostingProvisioningAllowed,
} from "./live-gates";

const KEYS = ["DOMAIN_REGISTER_LIVE", "HOSTING_TRIAL_LIVE", "NODE_ENV", "VITEST", "VITEST_WORKER_ID"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else (process.env as Record<string, string>)[k] = saved[k]!;
  }
});

/** Drop every marker that says "this is a test", to see the product default. */
function asProduction() {
  (process.env as Record<string, string>).NODE_ENV = "production";
  delete process.env.VITEST;
  delete process.env.VITEST_WORKER_ID;
}

describe("in a test run, ordering is never live by default", () => {
  it("an unset gate is SHUT", () => {
    delete process.env.DOMAIN_REGISTER_LIVE;
    delete process.env.HOSTING_TRIAL_LIVE;
    expect(domainOrderingAllowed()).toBe(false);
    expect(hostingProvisioningAllowed()).toBe(false);
  });

  it("an unrecognised value is SHUT rather than guessed open", () => {
    process.env.DOMAIN_REGISTER_LIVE = "maybe";
    expect(domainOrderingAllowed()).toBe(false);
  });

  /* A test that deliberately exercises the live path still can. Removing this
     would not make anything safer — it would make the refusal untestable, so
     the live path would go uncovered instead. */
  it("but an explicit ON still opens it, so the live path stays testable", () => {
    process.env.DOMAIN_REGISTER_LIVE = "1";
    expect(domainOrderingAllowed()).toBe(true);
  });

  it("recognises a test run from any of the three markers", () => {
    for (const marker of ["NODE_ENV", "VITEST", "VITEST_WORKER_ID"] as const) {
      asProduction();
      delete process.env.DOMAIN_REGISTER_LIVE;
      if (marker === "NODE_ENV") (process.env as Record<string, string>).NODE_ENV = "test";
      if (marker === "VITEST") process.env.VITEST = "true";
      if (marker === "VITEST_WORKER_ID") process.env.VITEST_WORKER_ID = "3";
      expect(domainOrderingAllowed(), `${marker} should mark a test run`).toBe(false);
    }
  });
});

describe("outside a test run, the gate is open by default", () => {
  beforeEach(asProduction);

  it("unset means ordering is allowed — the instruction", () => {
    delete process.env.DOMAIN_REGISTER_LIVE;
    delete process.env.HOSTING_TRIAL_LIVE;
    expect(domainOrderingAllowed()).toBe(true);
    expect(hostingProvisioningAllowed()).toBe(true);
  });

  it("an empty string means unset, not off", () => {
    process.env.DOMAIN_REGISTER_LIVE = "   ";
    expect(domainOrderingAllowed()).toBe(true);
  });

  /* ─── OFF HAS TO BE GENEROUS NOW ────────────────────────────────────────
     Under the old `=== "1"` rule every one of these closed the gate by
     accident of not being "1". Under a parsed rule they close it only if the
     parser knows the word — so an operator switching ordering off in a hurry
     must not be defeated by spelling. */
  it("every plausible spelling of off closes it", () => {
    for (const v of ["0", "false", "no", "off", "disabled", "disable", "none", "FALSE", " Off "]) {
      process.env.DOMAIN_REGISTER_LIVE = v;
      expect(domainOrderingAllowed(), `${JSON.stringify(v)} must close the gate`).toBe(false);
    }
  });

  it("the on spellings stay open", () => {
    for (const v of ["1", "true", "yes", "on", "enabled", "live", " TRUE "]) {
      process.env.DOMAIN_REGISTER_LIVE = v;
      expect(domainOrderingAllowed(), `${JSON.stringify(v)} must open the gate`).toBe(true);
    }
  });

  /* A value in neither list resolves OPEN, which is the instruction — and is
     also the one case where resolving silently would be wrong, because the
     likeliest reason for typing something unrecognised is trying to turn it
     OFF. It is flagged so the readiness screen can say so. */
  it("flags an unrecognised value instead of resolving it silently", () => {
    process.env.DOMAIN_REGISTER_LIVE = "nope-not-a-boolean";
    const d = liveGateDiagnostic("DOMAIN_REGISTER_LIVE");
    expect(d.open).toBe(true);
    expect(d.unrecognised).toBe(true);
    expect(d.because).toMatch(/does not recognise/i);
    expect(d.because).toMatch(/use 1 or 0/i);
  });

  it("does not flag a value it does know", () => {
    for (const v of ["1", "0"]) {
      process.env.DOMAIN_REGISTER_LIVE = v;
      expect(liveGateDiagnostic("DOMAIN_REGISTER_LIVE").unrecognised).toBe(false);
    }
  });
});

describe("the diagnostic an operator reads", () => {
  beforeEach(asProduction);

  /* The old copy said "set DOMAIN_REGISTER_LIVE=1". With ordering on by default
     a shut gate means somebody SET it shut, and telling them to switch on what
     is already on by default sends them chasing a cause that is not there. */
  it("says a shut gate was a deliberate choice, and how to undo it", () => {
    process.env.DOMAIN_REGISTER_LIVE = "0";
    const d = liveGateDiagnostic("DOMAIN_REGISTER_LIVE");
    expect(d.open).toBe(false);
    expect(d.because).toMatch(/explicitly set/i);
    expect(d.because).toMatch(/remove it, or set it to 1/i);
  });

  it("says an open gate is the default when nothing is set", () => {
    delete process.env.DOMAIN_REGISTER_LIVE;
    const d = liveGateDiagnostic("DOMAIN_REGISTER_LIVE");
    expect(d.open).toBe(true);
    expect(d.because).toMatch(/unset/i);
    expect(d.because).toMatch(/allowed by default/i);
  });

  it("names the test run as the reason when that is the reason", () => {
    (process.env as Record<string, string>).NODE_ENV = "test";
    delete process.env.DOMAIN_REGISTER_LIVE;
    const d = liveGateDiagnostic("DOMAIN_REGISTER_LIVE");
    expect(d.open).toBe(false);
    expect(d.because).toMatch(/test run/i);
  });

  /* Whatever it says, it must not repeat the value back: an env value is not a
     secret here, but this string goes to a screen and a log, and the habit of
     never echoing an env value is the one worth keeping. */
  it("never echoes the value it read", () => {
    process.env.DOMAIN_REGISTER_LIVE = "sentinel-value-9174";
    expect(liveGateDiagnostic("DOMAIN_REGISTER_LIVE").because).not.toContain("sentinel-value-9174");
  });
});

describe("the two gates are independent", () => {
  beforeEach(asProduction);

  it("switching domains off leaves hosting on", () => {
    process.env.DOMAIN_REGISTER_LIVE = "0";
    delete process.env.HOSTING_TRIAL_LIVE;
    expect(domainOrderingAllowed()).toBe(false);
    expect(hostingProvisioningAllowed()).toBe(true);
  });

  it("and the reverse", () => {
    delete process.env.DOMAIN_REGISTER_LIVE;
    process.env.HOSTING_TRIAL_LIVE = "off";
    expect(domainOrderingAllowed()).toBe(true);
    expect(hostingProvisioningAllowed()).toBe(false);
  });

  it("liveGateOpen reads the name it is given, not a fixed one", () => {
    process.env.DOMAIN_REGISTER_LIVE = "0";
    process.env.HOSTING_TRIAL_LIVE = "1";
    expect(liveGateOpen("DOMAIN_REGISTER_LIVE")).toBe(false);
    expect(liveGateOpen("HOSTING_TRIAL_LIVE")).toBe(true);
  });
});
