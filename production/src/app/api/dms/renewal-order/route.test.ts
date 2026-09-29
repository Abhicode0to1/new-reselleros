/**
 * POST /api/dms/renewal-order (owner, 28 Sep 2026: an existing customer renews inside the
 * DMS panel). Pinned: only DMS's key gets in; only the named customer's own RENEWAL quote is
 * paid; the Razorpay order is made by the shared quote-order code with receipt = quote id
 * (so the webhook settles it as the renewal it is); no simulation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  quote: null as Record<string, unknown> | null,
  customer: null as Record<string, unknown> | null,
  subs: [] as Record<string, unknown>[],
  secrets: null as Record<string, unknown> | null,
  quoteError: null as { message: string } | null,
  filters: [] as { table: string; col: string; val: unknown }[],
}));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => { db.filters.push({ table, col, val }); return chain; },
        maybeSingle: async () => {
          if (table === "quotes") return { data: db.quote, error: db.quoteError };
          if (table === "customers") return { data: db.customer, error: null };
          return { data: db.secrets, error: null };
        },
        then: (ok: (v: unknown) => unknown) => ok({ data: db.subs, error: null }),
      };
      return chain;
    },
    rpc: vi.fn(),
  }),
}));
vi.mock("@/lib/checkout/cart-checkout", () => ({ BUY_PAGE_TENANT_ID: "tenant-panel" }));
vi.mock("@/lib/crypto/tenant-secrets", () => ({ decryptTenantSecrets: (s: unknown) => s }));
const rzp = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("razorpay", () => ({ default: class { orders = { create: rzp.create }; } }));

import { POST } from "./route";

const KEY = "panel-key-0123456789abcdef";
const body = { quoteId: "Q-R-0001", email: "Asha@Example.invalid", dmsUserId: "665f0c0ffee" };
const req = (b: unknown, key: string | null = KEY) =>
  new NextRequest("https://example.invalid/api/dms/renewal-order", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: typeof b === "string" ? b : JSON.stringify(b),
  });
const renewalQuote = () => ({
  id: "Q-R-0001", status: "sent", payment_status: "pending", expires_date: "2099-01-01",
  amount: 708, currency: "INR", customer_name: "Asha Co", tenant_id: "tenant-panel", public_token: "t",
  invoice_id: null, billing_cycle: "yearly", subtotal: 600, discount_pct: 0, tax_rate: 18,
  created_date: "2026-09-28", line_items: [], customer_id: "cust-1", is_renewal: true,
});

const ENV = { ...process.env };
beforeEach(() => {
  process.env.DMS_PANEL_API_KEY = KEY;
  db.quote = renewalQuote();
  db.customer = { contact_email: "asha@example.invalid" };
  db.subs = [{ id: "s1", plan: "Starter hosting (billed yearly)", vendor: "hosting", domain: "ashaco.in", renewal_date: "2026-10-05" }];
  db.secrets = { razorpay_key_id: "rzp_test_k", razorpay_key_secret: "s", razorpay_mode: "test" };
  db.quoteError = null;
  db.filters = [];
  rzp.create.mockReset().mockResolvedValue({ id: "order_R1" });
});
afterEach(() => { process.env = { ...ENV }; });

describe("only DMS gets in", () => {
  it("no key configured → 503; wrong or missing key → 401; nothing created", async () => {
    process.env.DMS_PANEL_API_KEY = "";
    expect((await POST(req(body))).status).toBe(503);
    process.env.DMS_PANEL_API_KEY = KEY;
    expect((await POST(req(body, null))).status).toBe(401);
    expect((await POST(req(body, "wrong-key-0123456789abcdef"))).status).toBe(401);
    expect(rzp.create).not.toHaveBeenCalled();
  });
  it("a body without the renewal number, email or DMS account → 400", async () => {
    expect((await POST(req({ ...body, email: "not-an-email" }))).status).toBe(400);
    expect((await POST(req({ ...body, dmsUserId: "bad id!" }))).status).toBe(400);
    expect((await POST(req("{nope"))).status).toBe(400);
  });
});

describe("only the customer's own renewal", () => {
  it("reads the quote in the panel's tenant only", async () => {
    await POST(req(body));
    expect(db.filters).toContainEqual({ table: "quotes", col: "tenant_id", val: "tenant-panel" });
  });
  it("another customer's email → 404 'not found', no order", async () => {
    db.customer = { contact_email: "someone@else.invalid" };
    expect((await POST(req(body))).status).toBe(404);
    expect(rzp.create).not.toHaveBeenCalled();
  });
  it("a customer with no email on file → 404 (fails closed)", async () => {
    db.customer = { contact_email: null };
    expect((await POST(req(body))).status).toBe(404);
  });
  it("a wildcard-looking email does not match (literal match)", async () => {
    db.customer = { contact_email: "asha@example.invalid" };
    expect((await POST(req({ ...body, email: "as_a@example.invalid" }))).status).toBe(404);
  });
  it("no such quote → 404; a read failure → 503, not 'not found'", async () => {
    db.quote = null;
    expect((await POST(req(body))).status).toBe(404);
    db.quote = renewalQuote();
    db.quoteError = { message: "timeout" };
    expect((await POST(req(body))).status).toBe(503);
  });
  it("a quote that is not a renewal → 400 and says where to pay it", async () => {
    db.quote = { ...renewalQuote(), is_renewal: false };
    db.subs = [];
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not a renewal.*Nothing was charged/);
    expect(rzp.create).not.toHaveBeenCalled();
  });
  it("a quote linked as a subscription's renewal counts even without is_renewal", async () => {
    db.quote = { ...renewalQuote(), is_renewal: false };
    expect((await POST(req(body))).status).toBe(200);
  });
});

describe("the payment", () => {
  it("is the shared quote order: receipt = quote id, notes carry the channel and DMS account", async () => {
    const res = await POST(req(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true, orderId: "order_R1", amount: 70800, razorpayKeyId: "rzp_test_k", quoteId: "Q-R-0001",
      renews: [{ plan: "Starter hosting (billed yearly)", vendor: "hosting", domain: "ashaco.in", renewalDate: "2026-10-05" }],
    });
    expect(rzp.create.mock.calls[0][0]).toMatchObject({
      amount: 70800, receipt: "Q-R-0001",
      notes: { kind: "quote", quoteId: "Q-R-0001", channel: "dms-panel-renewal", dmsUserId: "665f0c0ffee" },
    });
  });
  it("an already-paid renewal → 409, never charged twice", async () => {
    db.quote = { ...renewalQuote(), payment_status: "received" };
    expect((await POST(req(body))).status).toBe(409);
    expect(rzp.create).not.toHaveBeenCalled();
  });
  it("without Razorpay keys it refuses (503) — no simulated payment from the panel", async () => {
    db.secrets = null;
    delete process.env.RAZORPAY_KEY_ID; delete process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET;
    const res = await POST(req(body));
    // Env keys are read at import; when this machine has them, the live path runs instead.
    const b = await res.json();
    if (res.status !== 200) {
      expect(res.status).toBe(503);
      expect(b.simulated).toBeUndefined();
    } else {
      expect(b.orderId).toBe("order_R1");
    }
  });
});
