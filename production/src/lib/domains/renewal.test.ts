/**
 * Domain renewals (owner, 25 Sep 2026: live price at renewal, full price, no free renewal).
 */
import { describe, it, expect, vi } from "vitest";
import {
  createDomainRenewalQuote,
  DOMAIN_RENEWAL_PLAN,
  domainRenewalEnabled,
  domainSubscriptionInsert,
  domainSubscriptionsToCreate,
  expiryEpochSeconds,
  renewalCommandId,
  type DomainRenewalQuoteInput,
} from "./renewal";

describe("switch and ids", () => {
  it("only an exact 1 turns automatic renewal on", () => {
    expect(domainRenewalEnabled({})).toBe(false);
    for (const v of ["", "0", "true", " 1"]) expect(domainRenewalEnabled({ DOMAIN_RENEWAL_LIVE: v }), v).toBe(false);
    expect(domainRenewalEnabled({ DOMAIN_RENEWAL_LIVE: "1" })).toBe(true);
  });
  it("one command id per row per IST day, distinct from registration's", () => {
    expect(renewalCommandId("R1", new Date("2026-09-25T05:00:00Z"))).toBe("rsos-domrenew-R1-2026-09-25");
    expect(renewalCommandId("R1", new Date("2026-09-25T20:00:00Z"))).toBe("rsos-domrenew-R1-2026-09-26"); // IST, not UTC
  });
  it("reads DMS's expiry as epoch seconds, and refuses an unusable one", () => {
    expect(expiryEpochSeconds("2027-09-25T00:00:00.000Z")).toBe(1821830400);
    expect(expiryEpochSeconds(null)).toBeNull();
    expect(expiryEpochSeconds("not a date")).toBeNull();
  });
});

describe("at the sale: one yearly subscription per paid domain", () => {
  it("takes only the lines that name a domain, once each", () => {
    const rows = domainSubscriptionsToCreate([
      { name: "acme.in", domain: "Acme.in", rate: 749, qty: 1 },
      { name: "Starter hosting (billed yearly)", rate: 600, qty: 1, hostingPlan: "starter" },
      { name: "dup", domain: "acme.in", rate: 749, qty: 1 },
    ]);
    expect(rows).toEqual([{ domain: "acme.in", mrr: 62 }]);
  });
  it("a domain free with yearly hosting still gets its subscription (mrr 0; the renewal is priced live, not from this)", () => {
    expect(domainSubscriptionsToCreate([{ domain: "free.in", rate: 0, qty: 1 }])).toEqual([{ domain: "free.in", mrr: 0 }]);
  });
  it("the row: vendor domain, 12 months, renewing a year out, NOT tied to the sale's quote", () => {
    const ins = domainSubscriptionInsert({ tenantId: "T", customerId: "C", customerName: "Acme", row: { domain: "acme.in", mrr: 62 }, today: "2026-09-25" });
    expect(ins).toMatchObject({ vendor: "domain", domain: "acme.in", term_months: 12, start_date: "2026-09-25", renewal_date: "2027-09-25", status: "active", quote_id: null, seats: 1 });
  });
});

/** A small fake of the admin client: records inserts/updates, answers the RPC. */
function fakeDb(opts: { existingQuote?: unknown; country?: string | null } = {}) {
  const calls = { rpc: 0, inserts: [] as Record<string, unknown>[], updates: [] as Record<string, unknown>[] };
  const q = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      select: self, eq: self,
      maybeSingle: async () => ({ data: table === "quotes" ? opts.existingQuote ?? null : table === "customers" ? { country: opts.country ?? "IN" } : null, error: null }),
      insert: async (row: Record<string, unknown>) => { calls.inserts.push(row); return { error: null }; },
      update: (row: Record<string, unknown>) => { calls.updates.push(row); return { eq: () => ({ eq: () => ({ select: async () => ({ data: [{ id: "S1" }], error: null }) }) }) }; },
    });
    return chain;
  };
  const db = {
    from: q,
    rpc: vi.fn(async () => { calls.rpc += 1; return { data: "Q-DR-0001", error: null }; }),
  };
  return { db: db as unknown as DomainRenewalQuoteInput["supabase"], calls };
}

const base = (db: DomainRenewalQuoteInput["supabase"]): DomainRenewalQuoteInput => ({
  supabase: db, subscriptionId: "S1", tenantId: "T", customerId: "C", customerName: "Acme",
  domain: "acme.in", renewalDate: "2027-09-25", graceDays: 7,
});

describe("the renewal quote is priced LIVE, at full price", () => {
  it("uses ResellerClub's renewal price for the extension, + 18% GST", async () => {
    const { db, calls } = fakeDb();
    const r = await createDomainRenewalQuote({ ...base(db), price: async () => ({ ok: true, rupees: 899 }) });
    expect(r).toMatchObject({ quoteId: "Q-DR-0001", subtotal: 899, amount: 1061, taxRate: 18, created: true });
    const quote = calls.inserts[0];
    expect(quote).toMatchObject({ is_renewal: true, extension_months: 12, plan: DOMAIN_RENEWAL_PLAN, domain: "acme.in", amount: 1061 });
    expect(calls.updates[0]).toEqual({ renewal_quote_id: "Q-DR-0001" });
  });

  it("the quote line names no domain — provisioning would read one as a domain to REGISTER", async () => {
    const { db, calls } = fakeDb();
    await createDomainRenewalQuote({ ...base(db), price: async () => ({ ok: true, rupees: 899 }) });
    const [line] = (calls.inserts[0].line_items as { domain?: string; commitment?: string }[]);
    expect(line.domain).toBeUndefined();
    expect(line.commitment).toBe("annual_yearly");
  });

  it("the line keeps the subscription's own name, so paying it does not rename the subscription", async () => {
    const { db, calls } = fakeDb();
    await createDomainRenewalQuote({ ...base(db), price: async () => ({ ok: true, rupees: 899 }) });
    const [line] = (calls.inserts[0].line_items as { name: string; description?: string }[]);
    const created = domainSubscriptionInsert({ tenantId: "T", customerId: "C", customerName: "Acme", row: { domain: "acme.in", mrr: 0 }, today: "2026-09-25" });
    expect(line.name).toBe(created.plan);
    expect(line.description).toBe("Renewal, 1 year");
  });

  it("price unreadable → no quote, and no document number spent", async () => {
    const { db, calls } = fakeDb();
    const r = await createDomainRenewalQuote({ ...base(db), price: async () => ({ ok: false, reason: "not reachable" }) });
    expect(r).toBeNull();
    expect(calls.rpc).toBe(0);
    expect(calls.inserts).toHaveLength(0);
  });

  it("an export customer is quoted with no GST", async () => {
    const { db } = fakeDb({ country: "US" });
    const r = await createDomainRenewalQuote({ ...base(db), price: async () => ({ ok: true, rupees: 899 }) });
    expect(r).toMatchObject({ amount: 899, taxRate: 0 });
  });

  it("an existing renewal quote is returned unchanged — the price is not re-read", async () => {
    const existing = { id: "Q-OLD", amount: 1000, subtotal: 847, discount_pct: 0, tax_rate: 18, line_items: [] };
    const { db, calls } = fakeDb({ existingQuote: existing });
    const price = vi.fn();
    const r = await createDomainRenewalQuote({ ...base(db), existingQuoteId: "Q-OLD", price });
    expect(r).toMatchObject({ quoteId: "Q-OLD", amount: 1000, created: false });
    expect(price).not.toHaveBeenCalled();
    expect(calls.rpc).toBe(0);
  });
});
