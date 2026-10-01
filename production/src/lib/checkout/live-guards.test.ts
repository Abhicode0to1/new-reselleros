/**
 * R-079 — a production deployment never simulates a payment and never files website orders
 * under the hard-coded dev tenant, whatever the env flags say.
 */
import { describe, it, expect } from "vitest";
import {
  BuyPageTenantMissingError,
  DEV_BUY_PAGE_TENANT_ID,
  buyPageTenantId,
  buyPageTenantIdOrEmpty,
  isProductionDeployment,
  simulatedPaymentAllowed,
} from "./live-guards";

describe("isProductionDeployment", () => {
  it("reads every deployed-server signal", () => {
    expect(isProductionDeployment({ NODE_ENV: "production" })).toBe(true);
    expect(isProductionDeployment({ NODE_ENV: "development", NEXT_PUBLIC_APP_ENV: "production" })).toBe(true);
    expect(isProductionDeployment({ NODE_ENV: "development", NEXT_PUBLIC_APP_ENV: "staging" })).toBe(true);
    expect(isProductionDeployment({ NODE_ENV: "development", K_SERVICE: "reselleros" })).toBe(true);
  });
  it("a laptop (next dev / vitest) is not production", () => {
    expect(isProductionDeployment({ NODE_ENV: "development" })).toBe(false);
    expect(isProductionDeployment({ NODE_ENV: "test", NEXT_PUBLIC_APP_ENV: "local" })).toBe(false);
  });
});

describe("simulatedPaymentAllowed", () => {
  it("is refused in production even with ALLOW_SIMULATED_CHECKOUT=1 / ALLOW_QUOTE_PAY_SIMULATION=1", () => {
    const env = { NODE_ENV: "production", ALLOW_SIMULATED_CHECKOUT: "1", ALLOW_QUOTE_PAY_SIMULATION: "1" };
    expect(simulatedPaymentAllowed({ env })).toBe(false);
  });
  it("is refused on Cloud Run and on a staging build", () => {
    expect(simulatedPaymentAllowed({ env: { NODE_ENV: "development", K_SERVICE: "x", ALLOW_SIMULATED_CHECKOUT: "1" } })).toBe(false);
    expect(simulatedPaymentAllowed({ env: { NODE_ENV: "development", NEXT_PUBLIC_APP_ENV: "staging" } })).toBe(false);
  });
  it("is refused when a LIVE Razorpay key is in hand, even on a laptop", () => {
    expect(simulatedPaymentAllowed({ env: { NODE_ENV: "development" }, razorpayKeyId: "rzp_live_abc" })).toBe(false);
  });
  it("stays available on a laptop for the walkthrough", () => {
    expect(simulatedPaymentAllowed({ env: { NODE_ENV: "development" } })).toBe(true);
    expect(simulatedPaymentAllowed({ env: { NODE_ENV: "development" }, razorpayKeyId: "rzp_test_abc" })).toBe(true);
  });
});

describe("buyPageTenantId", () => {
  it("uses the env value wherever it is set", () => {
    expect(buyPageTenantId({ NODE_ENV: "production", BUY_PAGE_TENANT_ID: " t-123 " })).toBe("t-123");
    expect(buyPageTenantId({ NODE_ENV: "development", BUY_PAGE_TENANT_ID: "t-123" })).toBe("t-123");
  });
  it("requires it in production, with an error that says what to set", () => {
    expect(() => buyPageTenantId({ NODE_ENV: "production" })).toThrow(BuyPageTenantMissingError);
    expect(() => buyPageTenantId({ NODE_ENV: "production", BUY_PAGE_TENANT_ID: "  " })).toThrow(/set BUY_PAGE_TENANT_ID on the deployment/);
    // The module-constant form fails closed rather than reaching the hard-coded tenant.
    expect(buyPageTenantIdOrEmpty({ NODE_ENV: "production" })).toBe("");
  });
  it("keeps the dev fallback only outside production", () => {
    expect(buyPageTenantId({ NODE_ENV: "development" })).toBe(DEV_BUY_PAGE_TENANT_ID);
    expect(buyPageTenantIdOrEmpty({ NODE_ENV: "test" })).toBe(DEV_BUY_PAGE_TENANT_ID);
  });
});
