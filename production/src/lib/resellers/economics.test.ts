import { describe, it, expect } from "vitest";
import {
  canTrade,
  walletBalance,
  canSpend,
  walletNeedsTopUp,
  slugify,
  availableSlug,
  isResellerStatus,
  LOW_WALLET_FLOOR,
} from "./economics";

/**
 * Every function here decides a rupee figure or whether somebody may trade, so
 * the tests are about the two directions each can fail in — and they are not
 * symmetrical. An unrecognised status must not read as "trade freely"; an
 * unknown wallet balance must not read as "spend away".
 */

describe("canTrade — only an approved reseller may order", () => {
  it("lets an approved reseller trade", () => {
    expect(canTrade({ tier: "reseller", resellerStatus: "approved" })).toEqual({ allowed: true });
  });

  it("holds a pending one, and says who has to act", () => {
    /* The person reading this is a reseller who has just been stopped. "Not
       allowed" tells them nothing about who to ask (§24). */
    const v = canTrade({ tier: "reseller", resellerStatus: "pending" });
    expect(v.allowed).toBe(false);
    expect(!v.allowed && v.reason).toMatch(/distributor/);
    expect(!v.allowed && v.reason).toMatch(/approve/);
  });

  it("stops a suspended one, and says how to be reinstated", () => {
    const v = canTrade({ tier: "reseller", resellerStatus: "suspended" });
    expect(v.allowed).toBe(false);
    expect(!v.allowed && v.reason).toMatch(/suspended/);
    expect(!v.allowed && v.reason).toMatch(/distributor/);
  });

  it("does NOT read an unrecognised status as approved", () => {
    /* A typo in a status column becoming "yes, trade freely" is the wrong
       direction to fail. */
    for (const s of ["", "Approved", "active", "enabled", "yes"]) {
      const v = canTrade({ tier: "reseller", resellerStatus: s });
      expect(v.allowed, s).toBe(false);
    }
  });

  it("does not gate a distributor at all", () => {
    /* A distributor trades on its own account. Refusing here would break the
       ordinary single-tenant case, which is every existing tenant. */
    expect(canTrade({ tier: "distributor", resellerStatus: "pending" })).toEqual({ allowed: true });
    expect(canTrade({ tier: "distributor", resellerStatus: "" })).toEqual({ allowed: true });
  });

  it("recognises exactly the three statuses", () => {
    for (const s of ["pending", "approved", "suspended"]) expect(isResellerStatus(s)).toBe(true);
    for (const s of ["", null, undefined, "APPROVED", "active"]) expect(isResellerStatus(s)).toBe(false);
  });
});

describe("walletBalance — the sum, and the only definition", () => {
  it("adds signed entries", () => {
    expect(walletBalance([
      { amount: 5000, reason: "topup" },
      { amount: -899, reason: "spend" },
      { amount: 899, reason: "refund" },
      { amount: -1200, reason: "spend" },
    ])).toBe(3800);
  });

  it("is zero for a wallet nobody has used", () => {
    expect(walletBalance([])).toBe(0);
  });

  it("skips a corrupt amount rather than returning NaN", () => {
    /* A single bad row must not make the whole balance unreadable — NaN would
       propagate into `canSpend` and stop every order. */
    expect(walletBalance([
      { amount: 5000, reason: "topup" },
      { amount: NaN, reason: "spend" },
    ])).toBe(5000);
  });

  it("can go negative, and says so rather than clamping", () => {
    /* If the ledger says -₹200 then something has overdrawn and hiding it as ₹0
       would make the discrepancy unfindable. */
    expect(walletBalance([{ amount: 100, reason: "topup" }, { amount: -300, reason: "spend" }])).toBe(-200);
  });
});

describe("canSpend — a prepaid wallet REFUSES an overdraft", () => {
  it("allows a spend it can cover, and says what is left", () => {
    expect(canSpend(5000, 899)).toEqual({ allowed: true, remainingAfter: 4101 });
    expect(canSpend(899, 899)).toEqual({ allowed: true, remainingAfter: 0 });
  });

  it("refuses and states the SHORTFALL", () => {
    /* "Insufficient balance" without a number makes the reseller guess how much
       to top up. */
    const v = canSpend(500, 899);
    expect(v.allowed).toBe(false);
    expect(!v.allowed && v.shortBy).toBe(399);
    expect(!v.allowed && v.reason).toMatch(/399/);
  });

  it("refuses on an unworkable balance — the OPPOSITE call to rcCanFund", () => {
    /* lib/resellerclub/reseller.ts returns null (do not block) on an unknown
       balance, because RC refuses the order itself before any registry is
       touched. Here the arrangement is prepaid and the risk lands on us: letting
       a sub-reseller register domains they have not paid for makes us their
       creditor without anyone agreeing to it. */
    expect(canSpend(NaN, 899).allowed).toBe(false);
  });

  it("refuses a nonsense amount", () => {
    for (const amt of [0, -50, NaN]) {
      expect(canSpend(5000, amt).allowed, String(amt)).toBe(false);
    }
  });

  it("refuses when the balance is already negative", () => {
    expect(canSpend(-200, 100).allowed).toBe(false);
  });
});

describe("walletNeedsTopUp", () => {
  it("warns below the floor", () => {
    expect(LOW_WALLET_FLOOR).toBe(500);
    expect(walletNeedsTopUp(499)).toBe(true);
    expect(walletNeedsTopUp(500)).toBe(false);
    expect(walletNeedsTopUp(0)).toBe(true);
  });

  it("takes a caller's floor", () => {
    expect(walletNeedsTopUp(1500, 2000)).toBe(true);
    expect(walletNeedsTopUp(1500, 1000)).toBe(false);
  });
});

describe("slugify — matches the CHECK constraint exactly", () => {
  const SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

  it("makes a URL handle from a business name", () => {
    expect(slugify("Acme Technologies Pvt Ltd")).toBe("acme-technologies-pvt-ltd");
    expect(slugify("Excel  Technologies")).toBe("excel-technologies");
  });

  it("strips accents rather than dropping the letter", () => {
    expect(slugify("Ácme Studio")).toBe("acme-studio");
  });

  it("never produces a leading or trailing hyphen", () => {
    for (const name of ["  Acme  ", "-Acme-", "!!!Acme!!!", "Acme & Co."]) {
      const s = slugify(name);
      expect(s, name).not.toBeNull();
      expect(SHAPE.test(s!), `${name} -> ${s}`).toBe(true);
    }
  });

  it("returns NULL rather than inventing a slug from nothing usable", () => {
    /* A tenant with no slug is fine. One with a meaningless slug owns a URL
       nobody can guess. */
    for (const name of ["", "   ", "!!!", "é", "ab", "—"]) {
      expect(slugify(name), JSON.stringify(name)).toBeNull();
    }
  });

  it("stays inside the 63-character limit, with no trailing hyphen", () => {
    const s = slugify("A".repeat(40) + " " + "B".repeat(40))!;
    expect(s.length).toBeLessThanOrEqual(63);
    expect(SHAPE.test(s)).toBe(true);
  });
});

describe("availableSlug", () => {
  it("takes the plain slug when it is free", () => {
    expect(availableSlug("Acme Ltd", new Set())).toBe("acme-ltd");
  });

  it("suffixes readably rather than randomly", () => {
    /* A reseller reads their own slug: "acme-ltd-2" is explicable where
       "acme-ltd-f3a9" is not. */
    expect(availableSlug("Acme Ltd", new Set(["acme-ltd"]))).toBe("acme-ltd-2");
    expect(availableSlug("Acme Ltd", new Set(["acme-ltd", "acme-ltd-2"]))).toBe("acme-ltd-3");
  });

  it("keeps the suffixed slug legal and inside the cap", () => {
    const base = slugify("C".repeat(70))!;
    const got = availableSlug("C".repeat(70), new Set([base]))!;
    expect(got.length).toBeLessThanOrEqual(63);
    expect(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(got)).toBe(true);
  });

  it("gives up rather than looping forever", () => {
    const taken = new Set(["acme", ...Array.from({ length: 60 }, (_, i) => `acme-${i + 2}`)]);
    expect(availableSlug("Acme", taken, 50)).toBeNull();
  });

  it("returns null when the name yields no slug at all", () => {
    expect(availableSlug("!!", new Set())).toBeNull();
  });
});
