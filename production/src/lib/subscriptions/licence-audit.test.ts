import { describe, it, expect } from "vitest";
import {
  parseVendorCsv, auditLicences, domainOf, mismatchNote, type BilledSub,
} from "./licence-audit";
import { rupee } from "@/lib/utils";

/** A Google Admin export, roughly as downloaded. */
const GOOGLE_CSV = [
  "First Name,Last Name,Email Address,Status",
  "Rajesh,Kumar,rajesh@acme.co.in,Active",
  "Priya,Nair,priya@acme.co.in,Active",
  "Old,Account,old@acme.co.in,Suspended",
  "Sunil,Rao,sunil@bgyh.com,Active",
].join("\n");

const sub = (over: Partial<BilledSub> = {}): BilledSub => ({
  id: "s1", customerName: "Acme Corp", plan: "Google Workspace Business Starter",
  domain: "acme.co.in", seats: 2, mrr: 3264, status: "active",
  ...over,
});

const google = () => true;

describe("reading a vendor export", () => {
  it("counts active accounts per domain", () => {
    const r = parseVendorCsv(GOOGLE_CSV);
    expect(r.perDomain).toEqual([
      { domain: "acme.co.in", seats: 2 },
      { domain: "bgyh.com", seats: 1 },
    ]);
  });

  /**
   * A suspended Google user still appears in the export and Google still bills for it, but
   * the customer is not using it. Counting it would report a shortfall that does not exist.
   */
  it("excludes suspended accounts, and SAYS which", () => {
    const r = parseVendorCsv(GOOGLE_CSV);
    expect(r.skipped).toEqual([{ row: 4, reason: "old@acme.co.in is suspended in the console" }]);
    expect(r.statusColumn).toBe("Status");
  });

  it("reads a Microsoft export's own column names", () => {
    const csv = [
      "Display name,User principal name,Block credential",
      "Sunil Rao,sunil@bgyh.com,false",
      "Gone,gone@bgyh.com,true",
    ].join("\n");
    const r = parseVendorCsv(csv);
    expect(r.perDomain).toEqual([{ domain: "bgyh.com", seats: 1 }]);
    expect(r.emailColumn).toBe("User principal name");
  });

  /**
   * The quoting matters: a Google CSV puts "Sharma, Rajesh" in the name column, and a
   * naive comma split shifts every later column by one — silently reading the wrong field
   * as the email.
   */
  it("survives a quoted comma in an earlier column", () => {
    const csv = [
      "Name,Email Address,Status",
      '"Sharma, Rajesh",rajesh@acme.co.in,Active',
    ].join("\n");
    expect(parseVendorCsv(csv).perDomain).toEqual([{ domain: "acme.co.in", seats: 1 }]);
  });

  it("names the columns it looked for when there is no email column", () => {
    const r = parseVendorCsv("Name,Seats\nAcme,10");
    expect(r.perDomain).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/Email Address/);
  });

  it("reports unusable rows rather than dropping them", () => {
    const r = parseVendorCsv("Email Address\nnot-an-email\n\nfine@acme.co.in");
    expect(r.perDomain).toEqual([{ domain: "acme.co.in", seats: 1 }]);
    expect(r.skipped).toHaveLength(1);
  });

  it("handles an empty file without throwing", () => {
    expect(parseVendorCsv("").perDomain).toEqual([]);
  });

  it("domainOf refuses anything that is not an address", () => {
    expect(domainOf("a@acme.co.in")).toBe("acme.co.in");
    expect(domainOf("A@ACME.CO.IN")).toBe("acme.co.in");
    expect(domainOf("nope")).toBeNull();
    expect(domainOf("a@localhost")).toBeNull();
  });
});

/**
 * ─── THE LEAK, AND THE THING THAT IS NOT A SAVING ───────────────────────────
 * Console MORE than billed means the reseller pays for seats nobody is charged for.
 * Console FEWER means the customer is over-charged — smaller in rupees, far worse in
 * trust, and never to be dressed up as good news.
 */
describe("comparing the console with the books", () => {
  it("finds seats the reseller is paying for and not billing", () => {
    const r = auditLicences([{ domain: "acme.co.in", seats: 5 }], [sub({ seats: 2, mrr: 3264 })], google);
    const m = r.mismatches[0];
    expect(m.kind).toBe("unbilled");
    expect(m.delta).toBe(3);
    /* 3264 / 2 = 1632 per seat per month, × 3 unbilled. */
    expect(m.monthlyAtStake).toBe(4896);
    expect(r.unbilledMonthly).toBe(4896);
  });

  it("reports over-billing separately, NOT as a saving", () => {
    const r = auditLicences([{ domain: "acme.co.in", seats: 1 }], [sub({ seats: 2, mrr: 3264 })], google);
    expect(r.mismatches[0].kind).toBe("over-billed");
    expect(r.overBilledMonthly).toBe(1632);
    /* Kept out of the leak figure entirely — netting them off would hide both. */
    expect(r.unbilledMonthly).toBe(0);
  });

  it("says nothing when the numbers agree", () => {
    const r = auditLicences([{ domain: "acme.co.in", seats: 2 }], [sub({ seats: 2 })], google);
    expect(r.mismatches).toEqual([]);
    expect(r.matched).toBe(1);
  });

  /** A plain inner join would drop this — the most valuable row in the report. */
  it("reports a console domain with NO subscription", () => {
    const r = auditLicences([{ domain: "ghost.com", seats: 8 }], [sub()], google);
    const m = r.mismatches.find((x) => x.domain === "ghost.com")!;
    expect(m.kind).toBe("no-subscription");
    expect(m.consoleSeats).toBe(8);
    /* No subscription means no known price. Inventing one would put a made-up number next
       to a real problem. */
    expect(m.monthlyAtStake).toBeNull();
  });

  it("SUMS several subscriptions on one domain", () => {
    /* A licence line plus a support line, or seats added later. Comparing against one row
       would report a shortfall that is only an incomplete lookup. */
    const r = auditLicences(
      [{ domain: "acme.co.in", seats: 13 }],
      [sub({ id: "a", seats: 12, mrr: 19584 }), sub({ id: "b", seats: 1, mrr: 833, plan: "Support" })],
      google,
    );
    expect(r.mismatches).toEqual([]);
    expect(r.matched).toBe(1);
  });

  it("lists an app domain missing from the file WITHOUT calling it money owed back", () => {
    /* A partial export is far likelier than a customer who vanished; treating it as a
       refund would turn a filtering accident into a credit note. */
    const r = auditLicences([], [sub({ seats: 2, mrr: 3264 })], google);
    const m = r.mismatches[0];
    expect(m.kind).toBe("not-in-export");
    expect(m.monthlyAtStake).toBeNull();
    expect(r.overBilledMonthly).toBe(0);
  });

  it("ignores cancelled subscriptions", () => {
    const r = auditLicences([], [sub({ status: "cancelled" })], google);
    expect(r.mismatches).toEqual([]);
  });

  it("respects the vendor scope, so a Google file says nothing about Microsoft rows", () => {
    const subs = [sub({ plan: "Google Workspace Business Starter" }),
                  sub({ id: "m", plan: "Microsoft 365 Business Basic", domain: "other.com" })];
    const r = auditLicences([{ domain: "acme.co.in", seats: 2 }], subs,
      (s) => (s.plan ?? "").startsWith("Google"));
    expect(r.mismatches).toEqual([]);
  });

  it("puts the money-losing rows first", () => {
    const r = auditLicences(
      [{ domain: "small.com", seats: 2 }, { domain: "big.com", seats: 20 }, { domain: "ghost.com", seats: 3 }],
      [sub({ id: "s", domain: "small.com", seats: 1, mrr: 100 }),
       sub({ id: "b", domain: "big.com",   seats: 10, mrr: 20000 })],
      google,
    );
    expect(r.mismatches.map((m) => m.kind)).toEqual(["unbilled", "unbilled", "no-subscription"]);
    expect(r.mismatches[0].domain).toBe("big.com");
  });
});

describe("what each row says", () => {
  it("names the customer, the counts and the monthly cost", () => {
    const r = auditLicences([{ domain: "acme.co.in", seats: 5 }], [sub({ seats: 2, mrr: 3264 })], google);
    const note = mismatchNote(r.mismatches[0], rupee);
    expect(note).toContain("Acme Corp");
    expect(note).toContain("₹4,896");
    expect(note).toMatch(/nobody is charged for/i);
  });

  it("tells the operator to check the export before believing a not-in-export row", () => {
    const r = auditLicences([], [sub()], google);
    expect(mismatchNote(r.mismatches[0], rupee)).toMatch(/exported the whole console/i);
  });
});
