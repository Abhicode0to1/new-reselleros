/**
 * Checkout's pay step tells the truth and asks for nothing twice (30 Sep 2026).
 *
 * - A cart with two hosting plans was refused only after Pay was pressed; the cart, the
 *   drawer and checkout's first step now warn as soon as the second plan is in.
 * - The payment picker's choice was never sent, and it offered "Bank transfer — NEFT/RTGS",
 *   which this checkout cannot take. Each option now opens Razorpay on that method.
 * - Razorpay asked for the mobile number again because it got 10 digits and wants +91.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { hostingLimitProblem, hostingLimitWarning } from "./hosting-limit";
import { razorpayContact } from "./razorpay-contact";

const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("hostingLimitWarning — the same rule, said before Pay", () => {
  const two = [{ sku: "hosting:standard", qty: 1 }, { sku: "hosting:plus", qty: 1 }];
  it("warns on two hosting plans, in words that fit before paying", () => {
    const w = hostingLimitWarning(two);
    expect(w).toMatch(/Your cart has 2 hosting plans/);
    expect(w).not.toMatch(/Nothing was charged/);
  });
  it("warns on one plan with quantity 2", () => {
    expect(hostingLimitWarning([{ sku: "hosting:starter", qty: 2 }])).toMatch(/quantity 2/);
  });
  it("is silent for one hosting account and for non-hosting lines", () => {
    expect(hostingLimitWarning([{ sku: "hosting:starter", qty: 1 }, { sku: "domain:.in", qty: 3 }])).toBeNull();
  });
  it("agrees with the server's refusal on every cart", () => {
    for (const lines of [two, [{ sku: "hosting:starter", qty: 2 }], [{ sku: "hosting:starter", qty: 1 }], []]) {
      expect(hostingLimitWarning(lines) === null).toBe(hostingLimitProblem(lines) === null);
    }
  });
  it("is shown in the cart, the drawer and checkout's first step", () => {
    for (const f of ["src/app/(marketing)/cart/page.tsx", "src/site/components/cart/CartDrawer.tsx", "src/app/(marketing)/checkout/page.tsx"]) {
      expect(code(f), f).toMatch(/hostingLimitWarning\(cart\.lines\)/);
      expect(code(f), f).toMatch(/\{hostingWarning && \(/);
    }
    expect(code("src/app/(marketing)/checkout/page.tsx")).toMatch(/if \(hostingWarning\) return;/);
  });
});

describe("razorpayContact", () => {
  it.each([
    ["9876543210", "+919876543210"],
    ["98765 43210", "+919876543210"],
    ["+91 98765 43210", "+919876543210"],
    ["09876543210", "+919876543210"],
  ])("%s → %s", (input, out) => {
    expect(razorpayContact(input)).toBe(out);
  });
  it("does not invent a number from too few digits", () => {
    expect(razorpayContact("12345")).toBe("12345");
  });
});

describe("the payment picker", () => {
  const c = code("src/app/(marketing)/checkout/page.tsx");
  it("offers no bank transfer, which checkout cannot take", () => {
    expect(c).not.toMatch(/Bank transfer|NEFT|RTGS/);
  });
  it("opens Razorpay on the chosen method, with the mobile in +91 form", () => {
    expect(c).toMatch(/razorpay: "upi"/);
    expect(c).toMatch(/razorpay: "netbanking"/);
    expect(c).toMatch(/razorpay: "card"/);
    expect(c).toMatch(/method: METHODS\.find\(\(m\) => m\.label === method\)\?\.razorpay/);
    expect(c).toMatch(/contact: razorpayContact\(phone\)/);
  });
});

describe("the several-plans switch", () => {
  it("stays OFF until provisioning queues one request per hosting line (board R-032)", async () => {
    const { SEVERAL_HOSTING_PLANS_READY } = await import("./hosting-limit");
    expect(SEVERAL_HOSTING_PLANS_READY).toBe(false);
  });
  it("on: two plans pass, a quantity above one is still refused", () => {
    const two = [{ sku: "hosting:starter", qty: 1 }, { sku: "hosting:plus", qty: 1 }];
    expect(hostingLimitProblem(two, true)).toBeNull();
    expect(hostingLimitWarning(two, true)).toBeNull();
    expect(hostingLimitProblem([{ sku: "hosting:starter", qty: 2 }], true)).toMatch(/add the plan once for each website/);
  });
});
