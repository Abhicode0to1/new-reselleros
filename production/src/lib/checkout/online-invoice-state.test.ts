/**
 * R-092: a returning buyer's GST invoice — the customer row reused by record_payment may have
 * no state, while the state the buyer just chose is on the order's lead. fillBlankCustomerState
 * fills ONLY a blank, and only from that order.
 */
import { describe, it, expect, vi } from "vitest";
import { fillBlankCustomerState } from "./online-invoice.server";

function admin(rows: { customer: Record<string, unknown> | null; lead: Record<string, unknown> | null }) {
  const updates: unknown[] = [];
  const filters: string[] = [];
  const chain = (table: string) => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.or = (f: string) => { filters.push(f); return q; };
    q.maybeSingle = async () => ({ data: table === "customers" ? rows.customer : rows.lead, error: null });
    q.update = (u: unknown) => { updates.push(u); return { eq: () => ({ eq: () => ({ or: (f: string) => { filters.push(f); return { select: async () => ({ data: [{ id: "c1" }], error: null }) }; } }) }) }; };
    return q;
  };
  return { client: { from: vi.fn(chain) } as never, updates, filters };
}
const args = { tenantId: "t1", quoteId: "Q1", leadId: "L1", customerId: "c1", logTag: "[t]" };

describe("fillBlankCustomerState", () => {
  it("a customer with no state takes the state the buyer chose on this order", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const a = admin({ customer: { state_code: null }, lead: { state_code: "29", state: "Karnataka" } });
    expect(await fillBlankCustomerState(a.client, args)).toBe("filled");
    expect(a.updates).toEqual([{ state_code: "29", state: "Karnataka" }]);
    expect(a.filters).toEqual(["state_code.is.null,state_code.eq."]); // the write itself only touches a blank
  });
  it("a recorded state is never overwritten", async () => {
    const a = admin({ customer: { state_code: "07" }, lead: { state_code: "29", state: "Karnataka" } });
    expect(await fillBlankCustomerState(a.client, args)).toBe("already");
    expect(a.updates).toEqual([]);
  });
  it("nothing is guessed: no state on the order means no write", async () => {
    const a = admin({ customer: { state_code: "" }, lead: { state_code: null, state: null } });
    expect(await fillBlankCustomerState(a.client, args)).toBe("nothing_to_fill");
    expect(a.updates).toEqual([]);
  });
  it("no customer or no lead on the quote: nothing to do", async () => {
    const a = admin({ customer: null, lead: null });
    expect(await fillBlankCustomerState(a.client, { ...args, customerId: null })).toBe("nothing_to_fill");
  });
});
