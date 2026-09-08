import { describe, it, expect } from "vitest";
import {
  classifyRegister,
  classifyRenew,
  classifyTransfer,
  classifyLookup,
  mustNotRetry,
  matchesAny,
  BALANCE_PENDING_FRAGMENTS,
  type RcRawResponse,
} from "./classify";

/**
 * These tests are the money guard for the domain integration.
 *
 * Registering a domain is irreversible spend. The failure mode that costs real
 * money is not "the call failed" — it is "the call succeeded upstream and we
 * read it as a failure and tried again". So the cases below are weighted
 * towards the three RC responses that LOOK like errors and are not:
 * balance-pending, processing-lock, and already-in-progress.
 *
 * Every message string here is a wording ResellerClub actually returns, ported
 * with the classifier from the engine that has been taking live RC traffic
 * since June 2026. They are fixtures, not inventions.
 */

const err = (message: string): RcRawResponse => ({ status: "error", message });

describe("classifyRegister — success", () => {
  it("reads the order id out of a successful registration", () => {
    const out = classifyRegister({ status: "success", data: { orderid: 123456 } });
    expect(out).toEqual({ kind: "registered", orderId: "123456" });
  });

  it("a numeric order id becomes a string — it is an identifier, not a quantity", () => {
    const out = classifyRegister({ status: "success", data: { orderid: 987 } });
    expect(out.kind === "registered" && typeof out.orderId).toBe("string");
  });

  it("success with NO order id is its own outcome, not a plain success", () => {
    // Filing this as `registered` would write an asset row with no way to renew
    // or transfer it later. The caller has to go and look the order up by name.
    expect(classifyRegister({ status: "success", data: {} }))
      .toEqual({ kind: "registered_no_order_id" });
    expect(classifyRegister({ status: "success" }))
      .toEqual({ kind: "registered_no_order_id" });
  });
});

describe("classifyRegister — the three that must never be retried", () => {
  it.each([
    "Insufficient balance in your account",
    "Your account balance is too low to place this order",
    "Low funds",
    "Insufficient Funds available",
    "Credit limit exceeded for this reseller",
    "Please contact support to complete this order",
  ])("balance wording %#: %s → balance_pending", (message) => {
    expect(classifyRegister(err(message)).kind).toBe("balance_pending");
  });

  it.each([
    "Order locked for processing",
    "This order is Locked for Processing, try later",
    "Domain registration is currently processing",
  ])("processing wording %#: %s → balance_pending", (message) => {
    expect(classifyRegister(err(message)).kind).toBe("balance_pending");
  });

  it.each([
    "Domain already exists in our database",
    "There is a pending order for this domain",
  ])("in-flight wording %#: %s → already_in_progress", (message) => {
    expect(classifyRegister(err(message)).kind).toBe("already_in_progress");
  });

  it("an explicit pending status short-circuits before any wording match", () => {
    expect(classifyRegister({ status: "pending", message: "whatever" }).kind)
      .toBe("balance_pending");
  });

  it("matching is case-insensitive — RC is not consistent about case", () => {
    expect(classifyRegister(err("INSUFFICIENT BALANCE")).kind).toBe("balance_pending");
    expect(classifyRegister(err("insufficient balance")).kind).toBe("balance_pending");
  });
});

describe("classifyRegister — hard failures", () => {
  it("an unrecognised error is a hard failure carrying RC's own words", () => {
    const out = classifyRegister(err("Invalid domain name syntax"));
    expect(out).toEqual({ kind: "hard_failure", reason: "Invalid domain name syntax" });
  });

  it("an error with no message still says something useful", () => {
    const out = classifyRegister({ status: "error" });
    expect(out.kind).toBe("hard_failure");
    expect(out.kind === "hard_failure" && out.reason).toMatch(/status=error/);
  });

  it("a hard failure is the ONLY register outcome that permits a retry", () => {
    expect(mustNotRetry(classifyRegister(err("Invalid domain name syntax")))).toBe(false);
    expect(mustNotRetry(classifyRegister(err("Insufficient balance")))).toBe(true);
    expect(mustNotRetry(classifyRegister(err("pending order")))).toBe(true);
    expect(mustNotRetry(classifyRegister({ status: "success", data: {} }))).toBe(true);
    expect(mustNotRetry(classifyRegister({ status: "success", data: { orderid: 1 } }))).toBe(false);
  });
});

describe("classifyRenew", () => {
  it("carries the order id and the price RC charged", () => {
    const out = classifyRenew({ status: "success", data: { orderid: 555, price: "899.0" } });
    expect(out).toEqual({ kind: "renewed", orderId: "555", price: 899 });
  });

  it("a non-numeric price is dropped rather than coerced to NaN", () => {
    const out = classifyRenew({ status: "success", data: { orderid: 555, price: "n/a" } });
    expect(out).toEqual({ kind: "renewed", orderId: "555", price: undefined });
  });

  it("shares register's balance vocabulary", () => {
    expect(classifyRenew(err("Insufficient balance")).kind).toBe("balance_pending");
    expect(classifyRenew(err("locked for processing")).kind).toBe("balance_pending");
  });

  it("has NO already_in_progress branch — a double renew is a hard failure a human must see", () => {
    expect(classifyRenew(err("pending order for this domain")).kind).toBe("hard_failure");
  });
});

describe("classifyTransfer", () => {
  it("returns the registry's tracking id", () => {
    expect(classifyTransfer({ status: "success", data: { entityid: "77" } }))
      .toEqual({ kind: "transfer_initiated", entityId: "77" });
  });

  it.each([
    "Invalid auth code supplied",
    "The authcode is incorrect",
    "Invalid EPP code",
    "Transfer is prohibited for this domain",
    "Domain has clientTransferProhibited status",
    "Domain is within the 60 day lock period",
    "Domain not allowed for transfer",
  ])("registry rejection %#: %s → transfer_rejected", (message) => {
    expect(classifyTransfer(err(message)).kind).toBe("transfer_rejected");
  });

  it("BALANCE IS CHECKED BEFORE REJECTION — we must never blame the customer's EPP code for our own empty account", () => {
    // This message carries BOTH vocabularies. Balance has to win, or the
    // customer is sent to fetch a new auth code that cannot possibly help.
    const both = err("Insufficient balance — auth code could not be verified");
    expect(matchesAny(both.message, BALANCE_PENDING_FRAGMENTS)).toBe(true);
    expect(classifyTransfer(both).kind).toBe("balance_pending");
  });

  it("an unrecognised transfer error is a hard failure, not a rejection", () => {
    expect(classifyTransfer(err("Registry timeout")).kind).toBe("hard_failure");
  });
});

describe("classifyLookup", () => {
  const pickOrderId = (d: Record<string, unknown>) => (d.orderid != null ? String(d.orderid) : null);

  it("found", () => {
    expect(classifyLookup({ status: "success", data: { orderid: 42 } }, pickOrderId))
      .toEqual({ kind: "found", value: "42" });
  });

  it("success with the field missing is not_found, not a hard failure", () => {
    expect(classifyLookup({ status: "success", data: {} }, pickOrderId).kind).toBe("not_found");
  });

  it.each([
    "404 Not Found",
    "No orders found for this domain",
    "No matching entity",
    "Domain does not exist",
    "Could not find the requested resource",
  ])("not-found wording %#: %s", (message) => {
    expect(classifyLookup(err(message), pickOrderId).kind).toBe("not_found");
  });

  it("NOT_FOUND AND HARD_FAILURE MUST STAY APART — collapsing them marks every domain lost during an RC outage", () => {
    // "no such domain" is an answer. A 500 is the absence of one. A sweep that
    // treats the second like the first writes 'lost' onto names we still own.
    expect(classifyLookup(err("No domain found"), pickOrderId).kind).toBe("not_found");
    expect(classifyLookup(err("Internal server error"), pickOrderId).kind).toBe("hard_failure");
  });
});

describe("matchesAny", () => {
  it("is safe on empty input rather than throwing into a money path", () => {
    expect(matchesAny(undefined, BALANCE_PENDING_FRAGMENTS)).toBe(false);
    expect(matchesAny(null, BALANCE_PENDING_FRAGMENTS)).toBe(false);
    expect(matchesAny("", BALANCE_PENDING_FRAGMENTS)).toBe(false);
  });
});
