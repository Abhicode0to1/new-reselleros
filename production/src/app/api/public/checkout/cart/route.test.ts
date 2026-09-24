/**
 * POST /api/public/checkout/cart — the site cart's checkout (24 Sep 2026 rework).
 *
 * Pinned, each for a defect that was live before this date:
 *  - a domain line is priced from the LIVE lookup the search shows (decision 19),
 *    for the EXACT name, and refused — never charged a guess — when that lookup
 *    is unreachable, the name is taken, or no name was sent;
 *  - the coupon the cart page shows is the coupon that is charged;
 *  - a domain-only cart is labelled so the webhook files it as a domain order;
 *  - a hosting account defaults to the domain bought in the same cart;
 *  - an item with no server-side price (Workspace, SSL…) is refused, not charged.
 *
 * Runs through the route's simulation path (no Razorpay keys, NODE_ENV=test), so
 * the quote it would charge is observable without calling Razorpay.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const inserts = vi.hoisted(() => ({ rows: [] as { table: string; row: Record<string, unknown> }[] }));
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      insert: async (row: Record<string, unknown>) => {
        inserts.rows.push({ table, row });
        return { error: null };
      },
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
    rpc,
  }),
}));
vi.mock("@/lib/crypto/tenant-secrets", () => ({ decryptTenantSecrets: () => null }));
vi.mock("@/lib/marketing/utm", () => ({ captureFromRequest: () => ({}) }));

const lookupDomains = vi.hoisted(() => vi.fn());
vi.mock("@/lib/domains/live-lookup", async (orig) => ({
  ...(await orig<typeof import("@/lib/domains/live-lookup")>()),
  lookupDomains,
}));

const startHostingTrial = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hosting/start-trial", () => ({ startHostingTrial }));

import { POST } from "./route";

const buyer = {
  fullName: "Test Buyer",
  companyName: "Test Co",
  email: "buyer@example.invalid",
  phone: "9999999999",
  simulate: true,
};

function req(body: Record<string, unknown>) {
  return new NextRequest("https://example.invalid/api/public/checkout/cart", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...buyer, ...body }),
  });
}

const quote = () => inserts.rows.find((r) => r.table === "quotes")?.row;
const address = { line1: "12 MG Road", city: "New Delhi", state: "Delhi", zipcode: "110001" };
const lead = () => inserts.rows.find((r) => r.table === "leads")?.row;

beforeEach(() => {
  inserts.rows = [];
  startHostingTrial.mockReset().mockResolvedValue({ ok: true, leadId: "L-TRIAL", trialEnds: "2026-10-09T00:00:00.000Z" });
  rpc.mockReset().mockImplementation(async (name: string) =>
    name === "next_document_number" ? { data: "Q-TEST-0001", error: null } : { data: null, error: null },
  );
  lookupDomains.mockReset().mockResolvedValue({
    ok: true,
    base: "acme",
    source: "engine",
    domains: [
      { domain: "acme.in", available: true, price: 749, currency: "INR", years: 1, priceKnown: true },
      { domain: "acme.com", available: false, price: 0, currency: "INR", years: 1, priceKnown: false },
    ],
  });
});

describe("domain lines — live price, exact name", () => {
  it("charges the live price for the named domain and records the name on the line", async () => {
    const res = await POST(req({ address, lines: [{ sku: "domain:in", label: "acme.in", domain: "acme.in", qty: 1 }] }));
    expect(res.status).toBe(200);
    expect(lookupDomains).toHaveBeenCalledWith("acme", ["in"]);
    const q = quote()!;
    const items = q.line_items as { name: string; rate: number; domain?: string }[];
    expect(items).toEqual([expect.objectContaining({ name: "Domain acme.in — registration, 1 year", rate: 749, domain: "acme.in" })]);
    expect(q.amount).toBe(Math.round(749 * 1.18));
    expect(q.plan).toBe("domain-registration"); // not "cart-order", which the webhook filed as 'other'
    expect(String(lead()!.notes)).toContain("Domains to register: acme.in");
  });

  it("refuses when the registry can't be reached — no quote, no guessed price", async () => {
    lookupDomains.mockResolvedValueOnce({ ok: false });
    const res = await POST(req({ lines: [{ sku: "domain:in", label: "acme.in", domain: "acme.in", qty: 1 }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/couldn't reach the domain registry/);
    expect(quote()).toBeUndefined();
  });

  it("refuses a taken name", async () => {
    const res = await POST(req({ lines: [{ sku: "domain:com", label: "acme.com", domain: "acme.com", qty: 1 }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/acme\.com \(it is no longer available/);
  });

  it("refuses a domain line with no name (the old placeholder shape)", async () => {
    const res = await POST(req({ lines: [{ sku: "domain:in", label: "yourname.in", qty: 1 }] }));
    expect(res.status).toBe(400);
    expect(lookupDomains).not.toHaveBeenCalled();
  });

  it("refuses a name whose extension differs from its sku, and a quantity above one", async () => {
    let res = await POST(req({ lines: [{ sku: "domain:com", domain: "acme.in", qty: 1 }] }));
    expect(res.status).toBe(400);
    res = await POST(req({ lines: [{ sku: "domain:in", domain: "acme.in", qty: 2 }] }));
    expect(res.status).toBe(400);
  });
});

describe("hosting + domain in one cart", () => {
  it("the domain is ₹0 with yearly hosting, and the hosting goes on it when none was typed", async () => {
    const res = await POST(req({
      address,
      lines: [
        { sku: "domain:in", domain: "acme.in", qty: 1 },
        { sku: "hosting:starter", cycle: "yearly", qty: 1 },
      ],
    }));
    expect(res.status).toBe(200);
    const items = quote()!.line_items as { rate: number; domain?: string }[];
    expect(items.find((i) => i.domain)?.rate).toBe(0);
    expect(quote()!.amount).toBe(708); // ₹600 Starter year + 18%
    expect(lead()!.domain).toBe("acme.in");
  });
});

describe("coupon — charged exactly as the cart page shows it", () => {
  it("ANUTECH10 takes 10% off before GST", async () => {
    const res = await POST(req({ coupon: "anutech10", domain: "x.in", lines: [{ sku: "hosting:standard", cycle: "yearly", qty: 1 }] }));
    expect(res.status).toBe(200);
    const q = quote()!;
    expect(q.subtotal).toBe(1500);
    expect(q.discount_pct).toBe(10);
    expect(q.amount).toBe(Math.round(1350 * 1.18)); // 1593
  });

  it("an unknown code counts for nothing, as on the cart page", async () => {
    await POST(req({ coupon: "FREE100", domain: "x.in", lines: [{ sku: "hosting:standard", cycle: "yearly", qty: 1 }] }));
    expect(quote()!.discount_pct).toBe(0);
    expect(quote()!.amount).toBe(1770);
  });
});

describe("items with no server-side price are refused, not charged", () => {
  it.each([
    [{ label: "Google Workspace Business Starter", qty: 5, cycle: "yearly" }],
    [{ label: "Positive SSL", qty: 1, cycle: "yearly" }],
    [{ sku: "ssl:positive", label: "Positive SSL", qty: 1 }],
  ])("%j", async (l) => {
    const res = await POST(req({ lines: [l] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/request a quote/);
    expect(quote()).toBeUndefined();
  });
});

describe("a domain is registered in the customer's own name (owner decision 22)", () => {
  it("refuses a domain cart with no address, and charges nothing", async () => {
    const res = await POST(req({ lines: [{ sku: "domain:in", domain: "acme.in", qty: 1 }] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.needAddress).toBe(true);
    expect(body.error).toMatch(/in your name we need your address, city, state, PIN code/);
    expect(quote()).toBeUndefined();
  });

  it("refuses a PIN that is not six digits", async () => {
    const res = await POST(req({ address: { ...address, zipcode: "1100" }, lines: [{ sku: "domain:in", domain: "acme.in", qty: 1 }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/PIN code/);
  });

  it("records the full registrant on the domain line, for the registration worker", async () => {
    const res = await POST(req({
      address,
      fullName: "Asha K Verma",
      phone: "+91 98765 43210",
      lines: [{ sku: "domain:in", domain: "acme.in", qty: 1 }],
    }));
    expect(res.status).toBe(200);
    const line = (quote()!.line_items as { registrant?: Record<string, unknown> }[])[0];
    expect(line.registrant).toEqual({
      firstName: "Asha",
      lastName: "K Verma",
      email: "buyer@example.invalid",
      phone: "9876543210",
      phoneCc: "91",
      companyName: "Test Co",
      address: { ...address, country: "IN" },
    });
  });

  it("a hosting-only cart needs no address", async () => {
    const res = await POST(req({ domain: "x.in", lines: [{ sku: "hosting:starter", cycle: "yearly", qty: 1 }] }));
    expect(res.status).toBe(200);
    const line = (quote()!.line_items as { registrant?: unknown }[])[0];
    expect(line.registrant).toBeUndefined();
  });
});

describe("a free Starter trial in the cart (24 Sep 2026: no form in between)", () => {
  const trial = { sku: "hosting-trial:starter", label: "Starter hosting — 15-day free trial", qty: 1, cycle: "monthly" };

  it("starts the trial with the cycle shown — no quote, no document number, nothing charged", async () => {
    const res = await POST(req({ lines: [trial], domain: "acme.in" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, trial: true, leadId: "L-TRIAL" });
    expect(startHostingTrial).toHaveBeenCalledTimes(1);
    expect(startHostingTrial.mock.calls[0][1]).toMatchObject({ email: buyer.email, domain: "acme.in", cycle: "monthly" });
    expect(quote()).toBeUndefined();
    expect(rpc).not.toHaveBeenCalledWith("next_document_number", expect.anything());
  });

  it("a trial with other items is refused whole — no trial started, nothing charged", async () => {
    const res = await POST(req({ lines: [trial, { sku: "hosting:starter", qty: 1, cycle: "yearly" }], domain: "acme.in" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("checks out on its own");
    expect(startHostingTrial).not.toHaveBeenCalled();
    expect(quote()).toBeUndefined();
  });

  it("a trial on any plan but Starter is refused", async () => {
    const res = await POST(req({ lines: [{ ...trial, sku: "hosting-trial:plus" }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("only on the Starter plan");
    expect(startHostingTrial).not.toHaveBeenCalled();
  });

  it("a trial with a quantity other than 1 is refused, not rounded", async () => {
    const res = await POST(req({ lines: [{ ...trial, qty: 5 }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("one hosting account");
    expect(startHostingTrial).not.toHaveBeenCalled();
  });

  it("a trial needs no domain — the owner helps a customer who has none", async () => {
    const res = await POST(req({ lines: [trial] }));
    expect(res.status).toBe(200);
    expect(startHostingTrial.mock.calls[0][1].domain).toBeUndefined();
  });
});
