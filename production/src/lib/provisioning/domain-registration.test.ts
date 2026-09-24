import { describe, it, expect } from "vitest";
import {
  coverFromPaid,
  domainRegistrationEnabled,
  normalisePhone,
  registrantFor,
  registrationCommandId,
  splitName,
  hostingProvisioningEnabled,
  provisionCommandId,
  hostingLineFor,
} from "./domain-registration";
import { classifyCommandResponse } from "@/lib/dms-engine/commands";

describe("the paying side's gate fails closed", () => {
  it("only an exact 1 opens it", () => {
    expect(domainRegistrationEnabled({})).toBe(false);
    for (const v of ["", "0", "true", "yes", " 1"]) expect(domainRegistrationEnabled({ DOMAIN_REGISTRATION_LIVE: v }), v).toBe(false);
    expect(domainRegistrationEnabled({ DOMAIN_REGISTRATION_LIVE: "1" })).toBe(true);
  });
});

describe("registrationCommandId — one id per request per IST day", () => {
  it("is stable within an IST day, so a re-run replays instead of re-registering", () => {
    const a = registrationCommandId("R1", new Date("2026-09-24T01:00:00Z"));
    const b = registrationCommandId("R1", new Date("2026-09-24T17:00:00Z"));
    expect(a).toBe(b);
    expect(a).toBe("rsos-domreg-R1-2026-09-24");
  });
  it("uses IST, not UTC — 20:00 UTC is already the next day in India (AGENTS.md §6)", () => {
    expect(registrationCommandId("R1", new Date("2026-09-24T20:00:00Z"))).toBe("rsos-domreg-R1-2026-09-25");
  });
});

describe("helpers", () => {
  it("cover is the pre-GST paid amount, rounded down", () => {
    expect(coverFromPaid(708)).toBe(600);
    expect(coverFromPaid(0)).toBe(0);
    expect(coverFromPaid(-5)).toBe(0);
  });
  it("finds the registrant for the named domain only", () => {
    const r = { firstName: "A" };
    const lines = [{ domain: "a.in", registrant: r }, { name: "Starter hosting" }];
    expect(registrantFor(lines, "A.IN")).toBe(r);
    expect(registrantFor(lines, "b.in")).toBeNull();
    expect(registrantFor(null, "a.in")).toBeNull();
  });
  it("splits names; one word fills both, as ResellerClub needs both", () => {
    expect(splitName("Asha K Verma")).toEqual({ firstName: "Asha", lastName: "K Verma" });
    expect(splitName("Asha")).toEqual({ firstName: "Asha", lastName: "Asha" });
  });
  it("normalises Indian numbers", () => {
    expect(normalisePhone("+91 98765 43210")).toEqual({ phone: "9876543210", phoneCc: "91" });
    expect(normalisePhone("098765 43210")).toEqual({ phone: "9876543210", phoneCc: "91" });
  });
});

describe("classifyCommandResponse — what the worker does with each engine answer", () => {
  it.each([
    [200, { status: "succeeded", result: { orderId: "9" } }, "done"],
    [200, { replayed: true, status: "succeeded", result: {} }, "done"],
    [200, { replayed: true, status: "failed", error: "[held] daily limit" }, "held"],
    [200, { replayed: true, status: "needs_reconciliation", error: "lost" }, "needs_reconciliation"],
    [500, { status: "needs_reconciliation", error: "lost", transport: "sent_unknown" }, "needs_reconciliation"],
    [500, { status: "failed", transport: "not_sent", error: "failed before provider", detail: "[held] test-mode payment" }, "held"],
    [500, { status: "failed", transport: "responded", error: "The provider refused the request: invalid" }, "refused"],
    [409, { error: "Something is already running" }, "busy"],
    [503, { error: "ENGINE_DOMAIN_REGISTER_LIVE" }, "gate_closed"],
    [502, {}, "unreachable"],
  ])("HTTP %i %j → %s", (status, body, kind) => {
    expect(classifyCommandResponse(status, body).kind).toBe(kind);
  });

  it("a hold keeps the engine's own sentence, so the person reading the queue sees why", () => {
    const o = classifyCommandResponse(500, { status: "failed", transport: "not_sent", error: "generic", detail: "[held] acme.in costs ₹550" });
    expect(o.kind === "held" && o.reason).toContain("acme.in costs ₹550");
  });
});

describe("hosting provisioning helpers", () => {
  it("the switch is exact 1 only", () => {
    expect(hostingProvisioningEnabled({})).toBe(false);
    expect(hostingProvisioningEnabled({ HOSTING_PROVISIONING_LIVE: "true" })).toBe(false);
    expect(hostingProvisioningEnabled({ HOSTING_PROVISIONING_LIVE: "1" })).toBe(true);
  });
  it("the command id is day-keyed and distinct from registration's", () => {
    expect(provisionCommandId("R1", new Date("2026-09-24T05:00:00Z"))).toBe("rsos-hostprov-R1-2026-09-24");
  });
  it("reads the plan and months from the line, then an older line's name, then the plan label", () => {
    expect(hostingLineFor([{ hostingPlan: "plus", months: 1 }], null)).toEqual({ planId: "plus", months: 1 });
    expect(hostingLineFor([{ name: "Starter hosting (billed monthly)" }], null)).toEqual({ planId: "starter", months: 1 });
    expect(hostingLineFor([], "hosting-standard")).toEqual({ planId: "standard", months: 12 });
    expect(hostingLineFor([], null)).toBeNull();
  });
});
