import { describe, it, expect } from "vitest";
import { receivedThisFy } from "./received-this-fy";

describe("receivedThisFy", () => {
  const fy = { start: "2026-04-01", end: "2027-03-31" };

  it("returns empty object when no payments are provided", () => {
    const res = receivedThisFy({
      payments: [],
      projectPayments: [],
      projectCustomer: new Map(),
      fy,
    });
    expect(res).toEqual({});
  });

  it("sums received payments within the financial year for a direct customer", () => {
    const res = receivedThisFy({
      payments: [
        {
          customer_id: "cust-1",
          amount: 5000,
          status: "received",
          received_at: "2026-05-15T10:00:00Z",
        },
        {
          customer_id: "cust-1",
          amount: 3000,
          status: "received",
          received_at: "2026-08-20T12:00:00Z",
        },
      ],
      projectPayments: [],
      projectCustomer: new Map(),
      fy,
    });

    expect(res["cust-1"]).toEqual({ total: 8000, tds: 0 });
  });

  it("ignores payments with status other than 'received'", () => {
    const res = receivedThisFy({
      payments: [
        {
          customer_id: "cust-1",
          amount: 5000,
          status: "pending",
          received_at: "2026-05-15T10:00:00Z",
        },
        {
          customer_id: "cust-1",
          amount: 2000,
          status: "failed",
          received_at: "2026-05-15T10:00:00Z",
        },
      ],
      projectPayments: [],
      projectCustomer: new Map(),
      fy,
    });

    expect(res["cust-1"]).toBeUndefined();
  });

  it("ignores payments outside of the current financial year", () => {
    const res = receivedThisFy({
      payments: [
        {
          customer_id: "cust-1",
          amount: 5000,
          status: "received",
          received_at: "2026-03-30T10:00:00Z", // Prior FY
        },
        {
          customer_id: "cust-1",
          amount: 3000,
          status: "received",
          received_at: "2027-04-05T10:00:00Z", // Next FY
        },
      ],
      projectPayments: [],
      projectCustomer: new Map(),
      fy,
    });

    expect(res["cust-1"]).toBeUndefined();
  });

  it("resolves customer via quoteCustomer map when customer_id is not directly on payment", () => {
    const quoteCustomer = new Map([["quote-101", "cust-2"]]);
    const res = receivedThisFy({
      payments: [
        {
          customer_id: null,
          quote_id: "quote-101",
          amount: 12500,
          status: "received",
          received_at: "2026-06-01T10:00:00Z",
        },
      ],
      quoteCustomer,
      projectPayments: [],
      projectCustomer: new Map(),
      fy,
    });

    expect(res["cust-2"]).toEqual({ total: 12500, tds: 0 });
  });

  it("includes project payments and tracks TDS separately", () => {
    const projectCustomer = new Map([
      ["proj-1", "cust-3"],
    ]);

    const res = receivedThisFy({
      payments: [],
      projectPayments: [
        {
          project_id: "proj-1",
          amount: 100000,
          method: "bank_transfer",
          received_at: "2026-07-10",
        },
        {
          project_id: "proj-1",
          amount: 10000,
          method: "tds",
          received_at: "2026-07-10",
        },
      ],
      projectCustomer,
      fy,
    });

    // Total should be 1,10,000 and TDS should be 10,000
    expect(res["cust-3"]).toEqual({ total: 110000, tds: 10000 });
  });
});
