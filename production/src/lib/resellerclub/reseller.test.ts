import { describe, it, expect } from "vitest";
import { parseRcAmount, parseResellerDetails, canFund } from "./reseller";

/**
 * The wallet that pays for every registration. The failure this guards against
 * is a paid customer with no domain, so the tests are mostly about ONE thing:
 * an unknown balance must never read as an empty one.
 */

describe("parseRcAmount — money that arrives as a string", () => {
  it("reads RC's decimal strings", () => {
    expect(parseRcAmount("14523.65")).toBe(14523.65);
    expect(parseRcAmount("0")).toBe(0);
    expect(parseRcAmount(" 250 ")).toBe(250);
  });

  it("survives thousands separators", () => {
    expect(parseRcAmount("1,14,523.65")).toBe(114523.65);
  });

  it("reports NULL for anything it cannot read, not 0", () => {
    /* The whole point. A false zero reads as "the wallet is empty" and would
       stop every sale the account can actually fund. */
    for (const bad of [undefined, null, "", "   ", "n/a", "unknown", {}, [], NaN]) {
      expect(parseRcAmount(bad), String(bad)).toBeNull();
    }
  });

  it("accepts a number, since RC is not consistent about the type", () => {
    expect(parseRcAmount(500)).toBe(500);
  });
});

describe("parseResellerDetails", () => {
  const flat = {
    resellerid: "123456",
    name: "Anutech",
    availablebalance: "14523.65",
    unutilisedsellingbalance: "500.00",
    lockedbalance: "1200.00",
    billingmode: "prepaid",
    resellerstatus: "Active",
    totalreceipts: "98000",
  };

  it("names the fields that matter", () => {
    const a = parseResellerDetails(flat);
    expect(a.resellerId).toBe("123456");
    expect(a.availableBalance).toBe(14523.65);
    expect(a.lockedBalance).toBe(1200);
    expect(a.status).toBe("Active");
    expect(a.billingMode).toBe("prepaid");
  });

  it("unwraps the nested envelope RC sometimes uses", () => {
    /* DMS had to handle both shapes — "Some APIs return { status, data },
       others return the data directly" — and reading the wrong one makes every
       field absent, which would report an unknown balance on a good response. */
    const a = parseResellerDetails({ status: "success", data: flat });
    expect(a.availableBalance).toBe(14523.65);
    expect(a.name).toBe("Anutech");
  });

  it("keeps the raw map for fields nothing has named", () => {
    expect(parseResellerDetails(flat).raw.totalreceipts).toBe("98000");
  });

  it("reports every balance as null when RC sent none", () => {
    const a = parseResellerDetails({ resellerstatus: "Active" });
    expect(a.availableBalance).toBeNull();
    expect(a.lockedBalance).toBeNull();
    expect(a.unutilisedSellingBalance).toBeNull();
  });

  it("does not mistake a genuinely empty wallet for an unknown one", () => {
    /* Zero IS a real answer, and the opposite mistake matters too: treating a
       true 0 as "unknown" would let an order through that cannot be paid for. */
    expect(parseResellerDetails({ availablebalance: "0" }).availableBalance).toBe(0);
  });
});

describe("canFund — and its deliberate third answer", () => {
  const withBalance = (availablebalance: string) => parseResellerDetails({ availablebalance });

  it("compares against the spendable balance", () => {
    expect(canFund(withBalance("1000"), 750)).toBe(true);
    expect(canFund(withBalance("1000"), 1000)).toBe(true);
    expect(canFund(withBalance("1000"), 1000.01)).toBe(false);
    expect(canFund(withBalance("0"), 1)).toBe(false);
  });

  it("returns NULL when the balance is unknown, rather than refusing", () => {
    /* Blocking checkout because a balance CHECK failed is its own outage. RC
       refuses an unfundable order before the registry is touched; a blocked
       checkout happens in front of the customer. */
    expect(canFund(parseResellerDetails({}), 750)).toBeNull();
  });

  it("does not count locked funds as spendable", () => {
    /* Locked money is real but committed to orders in flight. Adding it in
       would say an order can be funded when it cannot. */
    const a = parseResellerDetails({ availablebalance: "100", lockedbalance: "5000" });
    expect(canFund(a, 500)).toBe(false);
  });
});
