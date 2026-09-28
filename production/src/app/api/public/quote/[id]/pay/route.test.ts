/**
 * POST /api/public/quote/[id]/pay — pinned 28 Sep 2026, before its order-creation was
 * shared with the DMS panel's renewal payment (lib/checkout/quote-order.ts). Nothing here
 * had a test until then (L58), so these fix what the customer-facing pay button does today.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  quote: null as Record<string, unknown> | null,
  secrets: {} as Record<string, unknown> | null,
  rpc: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: table === "quotes" ? db.quote : db.secrets, error: null }),
        }),
      }),
    }),
    rpc: db.rpc,
  }),
}));
vi.mock("@/lib/crypto/tenant-secrets", () => ({ decryptTenantSecrets: (s: unknown) => s }));
const rzp = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("razorpay", () => ({ default: class { orders = { create: rzp.create }; } }));

import { POST } from "./route";

const TOKEN = "11111111-2222-4333-8444-555555555555";
const baseQuote = () => ({
  id: "Q-T-0001", status: "sent", payment_status: "pending", expires_date: "2099-01-01",
  amount: 708, currency: "INR", customer_name: "Asha Co", tenant_id: "t-1", public_token: TOKEN,
  invoice_id: null, billing_cycle: "yearly", subtotal: 600, discount_pct: 0, tax_rate: 18,
  created_date: "2026-09-28", line_items: [{ commitment: "annual_yearly" }],
});
const call = (t: string | null = TOKEN) =>
  POST(new NextRequest(`https://example.invalid/api/public/quote/Q-T-0001/pay${t ? `?t=${t}` : ""}`, { method: "POST" }), {
    params: Promise.resolve({ id: "Q-T-0001" }),
  });

const ENV = { ...process.env };
beforeEach(() => {
  db.quote = baseQuote();
  db.secrets = { razorpay_key_id: "rzp_test_k", razorpay_key_secret: "s", razorpay_mode: "test" };
  db.rpc.mockReset().mockResolvedValue({ error: null });
  rzp.create.mockReset().mockResolvedValue({ id: "order_T1" });
});
afterEach(() => { process.env = { ...ENV }; });

describe("who may pay", () => {
  it("a wrong or missing token looks like a missing quote", async () => {
    expect((await call("nope")).status).toBe(404);
    expect((await call(null)).status).toBe(404);
    expect(rzp.create).not.toHaveBeenCalled();
  });
});

describe("state guards", () => {
  it.each([
    [{ status: "draft" }, 400],
    [{ status: "rejected" }, 400],
    [{ payment_status: "received" }, 409],
    [{ invoice_id: "INV-1" }, 409],
    [{ expires_date: "2020-01-01" }, 400],
    [{ amount: 600 }, 409], // total disagrees with its own 18% GST
    [{ currency: "USD" }, 400],
  ])("%o → %i, no order", async (patch, status) => {
    db.quote = { ...baseQuote(), ...patch };
    expect((await call()).status).toBe(status);
    expect(rzp.create).not.toHaveBeenCalled();
  });
});

describe("the order", () => {
  it("is the quote total in paise, receipt = quote id, notes say kind quote", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, orderId: "order_T1", amount: 70800, razorpayKeyId: "rzp_test_k", razorpayMode: "test", quoteId: "Q-T-0001" });
    expect(rzp.create.mock.calls[0][0]).toMatchObject({
      amount: 70800, currency: "INR", receipt: "Q-T-0001",
      notes: { kind: "quote", quoteId: "Q-T-0001", tenantId: "t-1", customerName: "Asha Co" },
    });
  });
  it("a Razorpay failure is a retryable message, not a raw error", async () => {
    rzp.create.mockRejectedValue(new Error("boom"));
    const res = await call();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Could not start payment. Please retry.");
  });
  it("without Razorpay keys, outside production, it simulates through record_payment", async () => {
    db.secrets = null;
    delete process.env.RAZORPAY_KEY_ID; delete process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET;
    const res = await call();
    const body = await res.json();
    // The env keys are read at import; when this machine has them, the live path runs instead.
    if (body.simulated) {
      expect(db.rpc).toHaveBeenCalledWith("record_payment", expect.objectContaining({ p_quote_id: "Q-T-0001", p_amount: 708, p_reference: "SIM-QUOTEPAY-Q-T-0001" }));
    } else {
      expect(body.orderId).toBe("order_T1");
    }
  });
});
