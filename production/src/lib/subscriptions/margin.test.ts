import { describe, it, expect } from "vitest";
import {
  computeMargin,
  detectErosion,
  formatBps,
  THIN_MARGIN_BPS,
} from "./margin";
import { rupeesToPaise } from "./proration";

/** This tenant's real catalog rows, ₹/seat/month. */
const CATALOG = {
  gwsStarter:    { sell: 270,   cost: 110  },   // 59.3%
  gwsStandard:   { sell: 864,   cost: 620  },   // 28.2%
  gwsPlus:       { sell: 1380,  cost: 1150 },   // 16.7%
  gwsEnterprise: { sell: 2400,  cost: 2050 },   // 14.6%
  m365Premium:   { sell: 1900,  cost: 1620 },   // 14.7%
};

const margin = (sell: number, cost: number, seats = 10, vendor = "google") =>
  computeMargin({
    sellPerSeatMonthPaise: rupeesToPaise(sell),
    costPerSeatMonthPaise: rupeesToPaise(cost),
    seats, vendor,
  });

describe("computeMargin — against the real catalog", () => {
  /* Basis points computed at FULL precision, not read off a rounded display.
     Business Starter is 160/270 = 59.2592…% = 5926 bps. A first version of this
     test asserted 5930, derived from the "59.3%" a SQL query had already rounded
     to one decimal — the same mistake as taking a total off an invoice PDF and
     treating it as the exact figure. formatBps(5926) still renders "59.3%". */
  it.each([
    ["gwsStarter",    5926],
    ["gwsStandard",   2824],
    ["gwsPlus",       1667],
    ["gwsEnterprise", 1458],
    ["m365Premium",   1474],
  ] as const)("%s margin in basis points", (key, expected) => {
    const { sell, cost } = CATALOG[key];
    expect(margin(sell, cost).marginBps).toBe(expected);
    // And the display still reads as the catalog does.
    expect(formatBps(expected)).toMatch(/^\d+\.\d%$/);
  });

  it("shows why a hardcoded 17% could never have worked", () => {
    // add-seats derives cost as sell × 0.83, i.e. exactly 17% for everything.
    // Business Starter is really 59.3% and Enterprise 14.6% — one understated by
    // 42 points, the other overstated. A detector on 0.83 reports both as fine.
    const starter = margin(CATALOG.gwsStarter.sell, CATALOG.gwsStarter.cost).marginBps!;
    const ent     = margin(CATALOG.gwsEnterprise.sell, CATALOG.gwsEnterprise.cost).marginBps!;
    expect(starter).toBeGreaterThan(1_700);
    expect(ent).toBeLessThan(1_700);
  });

  it("margin is on REVENUE, not markup on cost", () => {
    // ₹110 -> ₹270 is 59% margin but 145% markup. Markup flatters the same trade.
    const r = margin(270, 110);
    expect(r.marginBps).toBe(5_926);
    expect(r.marginBps).not.toBe(14_545);
  });

  it("totals scale by seats and by twelve months", () => {
    const r = margin(270, 110, 10);
    expect(r.grossPerSeatMonthPaise).toBe(rupeesToPaise(160));
    expect(r.grossMonthlyPaise).toBe(rupeesToPaise(1_600));
    expect(r.grossAnnualPaise).toBe(rupeesToPaise(19_200));
  });
});

describe("computeMargin — status", () => {
  it("flags a LOSS when the vendor costs more than the customer pays", () => {
    const r = margin(270, 300);
    expect(r.status).toBe("loss");
    expect(r.isLoss).toBe(true);
    expect(r.marginBps).toBeLessThan(0);
    expect(r.grossPerSeatMonthPaise).toBe(rupeesToPaise(-30));
  });

  it("flags THIN below the threshold and healthy above it", () => {
    expect(margin(1000, 950).status).toBe("thin");      // 5%
    expect(margin(1000, 800).status).toBe("healthy");   // 20%
  });

  it("the threshold is a parameter — 10% is only a placeholder", () => {
    const input = {
      sellPerSeatMonthPaise: rupeesToPaise(1000),
      costPerSeatMonthPaise: rupeesToPaise(850),   // 15%
      seats: 10, vendor: "google",
    };
    expect(computeMargin(input).status).toBe("healthy");
    expect(computeMargin({ ...input, thinBelowBps: 2_000 }).status).toBe("thin");
    expect(THIN_MARGIN_BPS).toBe(1_000);
  });

  it("exactly at the threshold is thin, not healthy", () => {
    // 10% margin with a 10% floor — the floor is the minimum acceptable, so
    // sitting on it is not yet acceptable.
    expect(margin(1000, 900).marginBps).toBe(1_000);
    expect(margin(1000, 900).status).toBe("healthy");
    expect(computeMargin({
      sellPerSeatMonthPaise: rupeesToPaise(1000),
      costPerSeatMonthPaise: rupeesToPaise(900),
      seats: 1, vendor: "google", thinBelowBps: 1_001,
    }).status).toBe("thin");
  });
});

describe("computeMargin — a zero cost means two different things", () => {
  it("is UNKNOWN for a resold vendor, not 100%", () => {
    // A Google line with no wholesale recorded is missing data. Calling it 100%
    // would put the best number in the app on the row we know least about.
    for (const vendor of ["google", "microsoft", "zoho", "GOOGLE"]) {
      const r = margin(270, 0, 10, vendor);
      expect(r.status).toBe("unknown");
      expect(r.marginBps).toBeNull();
    }
  });

  it("is a genuine 100% for the reseller's OWN services", () => {
    // hosting / support / one-off development carry no vendor cost at all —
    // wholesale 0 in this tenant's catalog is correct for those.
    for (const vendor of ["hosting", "support", "other", "domain"]) {
      const r = margin(250, 0, 1, vendor);
      expect(r.status).toBe("healthy");
      expect(r.marginBps).toBe(10_000);
    }
  });

  it("is unknown when the sell price is zero or negative", () => {
    expect(margin(0, 100).marginBps).toBeNull();
    expect(margin(0, 100).status).toBe("unknown");
  });

  it("still reports the gross rupees even when the percentage is unknown", () => {
    const r = margin(270, 0, 10, "google");
    expect(r.marginBps).toBeNull();
    expect(r.grossMonthlyPaise).toBe(rupeesToPaise(2_700));
  });
});

describe("detectErosion — a vendor price rise on an already-sold subscription", () => {
  /** Sold at ₹270 when wholesale was ₹110. Vendor has since raised it to ₹300. */
  const eroded = {
    sellPerSeatMonthPaise:       rupeesToPaise(270),
    costPerSeatMonthPaise:       rupeesToPaise(300),
    costAtSalePerSeatMonthPaise: rupeesToPaise(110),
    seats: 10, vendor: "google",
  };

  it("catches the loss, and says how much margin was lost", () => {
    const r = detectErosion(eroded);
    expect(r.status).toBe("loss");
    expect(r.costRose).toBe(true);
    expect(r.costRisePerSeatPaise).toBe(rupeesToPaise(190));
    expect(r.marginAtSaleBps).toBe(5_926);   // healthy the day it was signed
    expect(r.marginBps).toBe(-1_111);        // losing money now
    expect(r.erodedBps).toBe(7_037);         // 70 points of margin gone
    expect(r.needsRepricing).toBe(true);
  });

  it("quantifies the bleed in rupees a year", () => {
    const r = detectErosion(eroded);
    // ₹30 a seat a month, 10 seats, 12 months.
    expect(r.grossAnnualPaise).toBe(rupeesToPaise(-3_600));
  });

  it("does not flag a subscription whose cost FELL", () => {
    const r = detectErosion({ ...eroded, costPerSeatMonthPaise: rupeesToPaise(90) });
    expect(r.costRose).toBe(false);
    expect(r.status).toBe("healthy");
    expect(r.needsRepricing).toBe(false);
  });

  it("flags a loss even when the cost at sale was never recorded", () => {
    // Demanding history before flagging a loss would silence exactly the rows with
    // the worst data. Erosion is the explanation; the loss is what to act on.
    const r = detectErosion({ ...eroded, costAtSalePerSeatMonthPaise: null });
    expect(r.needsRepricing).toBe(true);
    expect(r.status).toBe("loss");
    expect(r.costRose).toBe(false);
    expect(r.marginAtSaleBps).toBeNull();
    expect(r.erodedBps).toBeNull();
  });

  it("does not ask for repricing when the margin is merely lower but still healthy", () => {
    const r = detectErosion({
      sellPerSeatMonthPaise:       rupeesToPaise(864),
      costPerSeatMonthPaise:       rupeesToPaise(650),   // 24.8%
      costAtSalePerSeatMonthPaise: rupeesToPaise(620),   // was 28.2%
      seats: 5, vendor: "google",
    });
    expect(r.costRose).toBe(true);
    expect(r.erodedBps).toBeGreaterThan(0);
    expect(r.status).toBe("healthy");
    expect(r.needsRepricing).toBe(false);
  });
});

describe("formatBps", () => {
  it("renders one decimal", () => {
    expect(formatBps(5_930)).toBe("59.3%");
    expect(formatBps(-1_111)).toBe("-11.1%");
    expect(formatBps(0)).toBe("0.0%");
  });

  it("renders an UNKNOWN margin as a dash, never as 0%", () => {
    expect(formatBps(null)).toBe("—");
    expect(formatBps(undefined)).toBe("—");
  });
});
