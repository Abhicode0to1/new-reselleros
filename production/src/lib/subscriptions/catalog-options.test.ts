import { describe, it, expect } from "vitest";
import {
  subscriptionProducts, catalogVendors, vendorSelectOptions, productsForVendor,
  findProduct, judgePrice,
} from "./catalog-options";
import type { Item } from "@/lib/supabase/database.types";

/**
 * The tenant's real `items` rows, read from the DB on 14 Aug 2026. msrp and wholesale
 * are ₹/seat/MONTH; hosting/support rows have `prices` null and only msrp.
 */
const item = (
  id: string, name: string, vendor: Item["vendor"], msrp: number, wholesale: number,
  withPrices = true,
): Item => ({
  id, name, vendor, msrp, wholesale,
  prices: withPrices ? { annual: { msrp, wholesale }, monthly: { msrp, wholesale } } : null,
  item_type: "subscription",
} as unknown as Item);

const CATALOG: Item[] = [
  item("GW-STR-fbb", "Google Workspace Business Starter", "google",    270,  110),
  item("GW-STD-fbb", "Google Workspace Standard",         "google",    864,  620),
  item("GW-PLS-fbb", "Google Workspace Plus",             "google",   1380, 1150),
  item("GW-ENT-fbb", "Google Workspace Enterprise",       "google",   2400, 2050),
  item("MS-BAS",     "Microsoft 365 Business Basic",      "microsoft", 200,  165),
  item("MS-STD",     "Microsoft 365 Business Standard",   "microsoft", 990,  820),
  item("MS-PRM",     "Microsoft 365 Business Premium",    "microsoft",1900, 1620),
  item("ZO-STD",     "Zoho Workplace Standard",           "zoho",      120,   95),
  item("ZO-PRO",     "Zoho Workplace Professional",       "zoho",      280,  220),
  item("HST-STD",    "Standard",                          "hosting",   125,    0, false),
  item("SUP-PRM",    "Premium",                           "support",  1667,    0, false),
];

const products = subscriptionProducts(CATALOG);

describe("subscriptionProducts — ₹/seat/month becomes ₹/seat/year, once", () => {
  it.each([
    ["GW-STR-fbb",  3_240,  1_320],
    ["GW-STD-fbb", 10_368,  7_440],
    ["MS-STD",     11_880,  9_840],
    ["MS-PRM",     22_800, 19_440],
    ["ZO-STD",      1_440,  1_140],
  ] as const)("%s sell and cost per year", (id, sell, cost) => {
    const p = findProduct(products, id)!;
    expect(p.annualSellPerSeat).toBe(sell);
    expect(p.annualCostPerSeat).toBe(cost);
  });

  it("reads msrp for rows with no `prices` jsonb — hosting and support have only msrp", () => {
    expect(findProduct(products, "HST-STD")!.annualSellPerSeat).toBe(1_500);
    expect(findProduct(products, "SUP-PRM")!.annualSellPerSeat).toBe(20_004);
  });

  it("keeps a genuine ₹0 cost as 0, not as unknown", () => {
    // These are the reseller's own services. 0 is the true cost.
    expect(findProduct(products, "HST-STD")!.annualCostPerSeat).toBe(0);
  });

  it("drops one-time items — they are not something a subscription renews", () => {
    const withOneOff = subscriptionProducts([
      ...CATALOG,
      { ...item("SSL-1", "SSL Certificate", "other", 3_500, 0), item_type: "one_time" } as Item,
    ]);
    expect(findProduct(withOneOff, "SSL-1")).toBeUndefined();
  });
});

describe("what the hardcoded dialog list used to pre-fill", () => {
  /* The reason this change exists. The old PRODUCTS_BY_VENDOR defaults, ₹/seat/year,
     against the catalog's own cost. FOUR of eight were below cost — a loss suggested
     by the app before a sale was even made, with nothing on screen to mark it. */
  const OLD_DEFAULT: Array<[string, number]> = [
    ["GW-STR-fbb",  2_160],
    ["GW-STD-fbb", 10_080],
    ["GW-PLS-fbb", 15_120],
    ["MS-BAS",      1_800],
    ["MS-STD",      7_920],
    ["MS-PRM",     18_000],
    ["ZO-STD",      1_188],
    ["ZO-PRO",      2_388],
  ];

  it.each(OLD_DEFAULT)("%s: the old default vs the catalog", (id, oldPrice) => {
    const p = findProduct(products, id)!;
    // Every old default undercut the catalog's own list price.
    expect(oldPrice).toBeLessThan(p.annualSellPerSeat);
  });

  it("names the four that were BELOW COST, and by how much", () => {
    /* All three Microsoft products plus Zoho Professional. A first version of this
       test asserted three because Zoho Professional was missing from the fixture —
       i.e. the test covered less than the finding it was written for. */
    const below = OLD_DEFAULT
      .map(([id, oldPrice]) => ({ id, oldPrice, cost: findProduct(products, id)!.annualCostPerSeat! }))
      .filter((r) => r.oldPrice < r.cost);

    expect(below.map((r) => r.id)).toEqual(["MS-BAS", "MS-STD", "MS-PRM", "ZO-PRO"]);
    // M365 Business Standard: ₹7,920 sold against a ₹9,840 cost.
    const msStd = below.find((r) => r.id === "MS-STD")!;
    expect(msStd.cost - msStd.oldPrice).toBe(1_920);
  });

  it("the catalog price is never below cost for any of them", () => {
    for (const [id] of OLD_DEFAULT) {
      const p = findProduct(products, id)!;
      expect(p.annualSellPerSeat).toBeGreaterThan(p.annualCostPerSeat!);
    }
  });
});

describe("catalogVendors — the four-vendor list hid three", () => {
  it("surfaces hosting and support, which the DB enum always allowed", () => {
    const vendors = catalogVendors(products);
    expect(vendors).toContain("hosting");
    expect(vendors).toContain("support");
  });

  it("lists only vendors the tenant actually sells", () => {
    expect(catalogVendors(products)).not.toContain("domain");
  });

  it("is empty for an empty catalog — the dialog handles that, it does not invent one", () => {
    expect(catalogVendors(subscriptionProducts([]))).toEqual([]);
  });
});

describe("vendorSelectOptions — the dropdown a reseller actually sees", () => {
  it("never lists the same vendor twice", () => {
    /* The bug this exists for, reported from the live app: the dialog built this
       list in two places — a fallback substituting ["other"] on an empty catalogue,
       and a guard appending "other" when the catalogue lacked it. On an empty
       catalogue both fired and the dropdown showed "Other Cloud Vendor" TWICE. */
    for (const set of [[], products, subscriptionProducts([CATALOG[0]])]) {
      const opts = vendorSelectOptions(set);
      expect(new Set(opts).size).toBe(opts.length);
    }
  });

  it("offers `other` even when the catalogue is empty", () => {
    /* A tenant who has not added any products still has to be able to onboard a
       subscription under a custom plan name. */
    expect(vendorSelectOptions([])).toEqual(["other"]);
  });

  it("does not add a second `other` when the catalogue already sells one", () => {
    const withOther = subscriptionProducts([
      ...CATALOG, item("OTH-1", "Some resold thing", "other", 500, 400, false),
    ]);
    const opts = vendorSelectOptions(withOther);
    expect(opts.filter((v) => v === "other")).toHaveLength(1);
  });

  it("keeps every vendor the tenant sells, with `other` last", () => {
    const opts = vendorSelectOptions(products);
    for (const v of catalogVendors(products)) expect(opts).toContain(v);
    expect(opts[opts.length - 1]).toBe("other");
  });
});

describe("productsForVendor — no cross-vendor bleed", () => {
  it("does not return hosting's 'Standard' under google", () => {
    const google = productsForVendor(products, "google").map((p) => p.id);
    expect(google).not.toContain("HST-STD");
    expect(productsForVendor(products, "hosting").map((p) => p.id)).toEqual(["HST-STD"]);
  });
});

describe("judgePrice — the live check next to the field", () => {
  it("calls a below-cost price a LOSS and says the shortfall", () => {
    // The exact case: M365 Business Standard at the old default.
    const v = judgePrice(7_920, 9_840);
    expect(v).toEqual({ kind: "loss", shortfallPerSeatYear: 1_920 });
  });

  it("calls a thin margin thin", () => {
    // GWS Plus at the old ₹15,120 default against ₹13,800 cost — 8.7%.
    const v = judgePrice(15_120, 13_800);
    expect(v.kind).toBe("thin");
    expect(v.kind === "thin" && Math.round(v.marginPct * 10) / 10).toBe(8.7);
  });

  it("passes a healthy margin", () => {
    const v = judgePrice(3_240, 1_320);
    expect(v.kind).toBe("ok");
    expect(v.kind === "ok" && Math.round(v.marginPct * 10) / 10).toBe(59.3);
  });

  it("says UNKNOWN rather than 100% when no cost is recorded", () => {
    expect(judgePrice(5_000, null)).toEqual({ kind: "unknown" });
  });

  it("treats a real ₹0 cost as a genuine 100% margin", () => {
    // hosting/support: no vendor cost exists, so this one IS 100%.
    expect(judgePrice(1_500, 0)).toEqual({ kind: "ok", marginPct: 100 });
  });

  it("is unknown at a zero price — nothing to divide by", () => {
    expect(judgePrice(0, 1_000)).toEqual({ kind: "unknown" });
  });

  it("exactly at cost is a thin 0%, not a loss", () => {
    expect(judgePrice(9_840, 9_840)).toEqual({ kind: "thin", marginPct: 0 });
  });
});
