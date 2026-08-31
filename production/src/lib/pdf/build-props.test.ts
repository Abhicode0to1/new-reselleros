import { describe, it, expect } from "vitest";
import { quoteAmounts, buildInvoicePdfProps, buildQuotePdfProps, type TenantPdfInfo } from "./build-props";
import type { Invoice, Quote, Customer } from "@/lib/supabase/database.types";

const tenant: TenantPdfInfo = {
  name: "Anutech", gstin: "27AABCE1234D1Z9", email: "a@x.in", phone: "+91",
  address: "Mumbai", state: "Maharashtra", state_code: "27",
  /* The STORED url. build-props never fetches it — it is sync and pure — so the renderable
     logo arrives separately as `logoDataUri`. See the two tests at the bottom of this file. */
  logo_url: "https://cdn.example/logo.png",
};

describe("quoteAmounts", () => {
  it("computes discount/taxable/tax with the app's rounding", () => {
    const a = quoteAmounts({ subtotal: 100000, discount_pct: 10, tax_rate: 18, amount: 132840 });
    expect(a.discount).toBe(10000);   // round(100000 * 10%)
    expect(a.taxable).toBe(90000);    // 100000 - 10000
    expect(a.tax).toBe(16200);        // round(90000 * 18%)
    expect(a.total).toBe(132840);     // authoritative quote.amount
  });
  it("falls back total to taxable+tax when amount is null", () => {
    const a = quoteAmounts({ subtotal: 1000, discount_pct: 0, tax_rate: 18, amount: null });
    expect(a.total).toBe(1180);
  });
});

describe("buildInvoicePdfProps", () => {
  const invoice = { id: "INV-1", amount: 38232, customer_name: "Acme", tenant_id: "t1" } as Invoice;
  const quote = { subtotal: 32400, discount_pct: 0, tax_rate: 18, amount: 38232, line_items: [] } as unknown as Quote;

  it("uses quote.amount as total and derives the breakdown", () => {
    const p = buildInvoicePdfProps({ invoice, quote, customer: null, tenant });
    expect(p.total).toBe(38232);
    expect(p.subtotal).toBe(32400);
    expect(p.tax).toBe(5832);
    expect(p.interState).toBe(false); // no customer state → intra-state default
  });

  it("marks inter-state when customer state differs from tenant", () => {
    const customer = { state_code: "07", gstin: null, contact_email: null, address: null, state: "Delhi" } as unknown as Customer;
    expect(buildInvoicePdfProps({ invoice, quote, customer, tenant }).interState).toBe(true);
  });

  it("carries the quote's foreign currency onto the invoice PDF (export USD invoice)", () => {
    const usdQuote = { ...quote, currency: "USD", exchange_rate: 83 } as unknown as Quote;
    const p = buildInvoicePdfProps({ invoice, quote: usdQuote, customer: null, tenant });
    expect(p.currency).toBe("USD");
    expect(p.exchangeRate).toBe(83);
  });

  it("has no foreign currency for a domestic (₹) quote", () => {
    const p = buildInvoicePdfProps({ invoice, quote, customer: null, tenant });
    expect(p.currency ?? null).toBeNull();
  });

  it("quote-less invoice derives real GST from the inclusive amount (MONEY-5)", () => {
    // No quote (e.g. project-milestone invoice) + no persisted breakdown →
    // reverse-derive at 18% so the PDF shows real GST, not ₹0.
    const p = buildInvoicePdfProps({ invoice, quote: null, customer: null, tenant });
    expect(p.total).toBe(38232);
    expect(p.subtotal).toBe(32400);   // taxable = round(38232 × 100/118)
    expect(p.taxable).toBe(32400);
    expect(p.tax).toBe(5832);         // 38232 − 32400
    expect(p.taxRate).toBe(18);
    expect(p.lineItems).toEqual([]);
  });

  it("quote-less invoice uses the breakdown persisted on the invoice (migration 0116)", () => {
    const inv = { id: "INV-2", amount: 118000, customer_name: "Acme", tenant_id: "t1",
      taxable_value: 100000, tax_amount: 18000, tax_rate: 18, inter_state: true } as unknown as Invoice;
    const p = buildInvoicePdfProps({ invoice: inv, quote: null, customer: null, tenant });
    expect(p.taxable).toBe(100000);
    expect(p.tax).toBe(18000);
    expect(p.total).toBe(118000);
    expect(p.interState).toBe(true);  // persisted head wins
  });
});

describe("buildQuotePdfProps", () => {
  const quote = {
    id: "Q-1", customer_name: "Acme", subtotal: 10000, discount_pct: 0, tax_rate: 18, amount: 11800,
    line_items: [], created_date: "2026-01-01", expires_date: "2026-01-15", notes: null, is_renewal: false,
  } as unknown as Quote;

  it("maps fields + computes validity days from the date span", () => {
    const p = buildQuotePdfProps({ quote, customer: null, tenant });
    expect(p.quoteId).toBe("Q-1");
    expect(p.total).toBe(11800);
    expect(p.validityDays).toBe(14);
    expect(p.tenantName).toBe("Anutech");
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Logo: build-props ise FETCH nahi karta — wo sync aur pure hai, aur ek image laana wahan
   hona chahiye jahan deadline aur failure sambhali ja sake, na ki ek renderer ke andar jo
   inbound-mail ke webhook par chal raha hai.
   ───────────────────────────────────────────────────────────────────────────── */
describe("quote PDF props me logo", () => {
  const quote = { id: "Q-1", customer_name: "X", subtotal: 1000, discount_pct: 0,
    tax_rate: 18, amount: 1180, line_items: [] } as unknown as Quote;

  it("resolve kiya hua data URI aage pahunchta hai", () => {
    const p = buildQuotePdfProps({ quote, customer: null, tenant, logoDataUri: "data:image/png;base64,AA" });
    expect(p.tenantLogo).toBe("data:image/png;base64,AA");
  });

  it("na diya jaye to null — tenant.logo_url CHUP-CHAAP use nahi hota", () => {
    /* Ye asli jaanch hai. `tenant.logo_url` upar fixture me maujood hai. Agar build-props use
       seedha aage bhej deta, to renderer ko ek URL milta aur wo bina kisi deadline ke network
       call kar baithta — theek wahi cheez jise `isRenderableLogo` rokta hai. */
    const p = buildQuotePdfProps({ quote, customer: null, tenant });
    expect(p.tenantLogo).toBeNull();
    expect(p.tenantLogo).not.toBe(tenant.logo_url);
  });
});
