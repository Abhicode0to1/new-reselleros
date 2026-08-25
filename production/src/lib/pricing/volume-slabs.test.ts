import { describe, it, expect } from "vitest";
import {
  CUSTOM_PRICING_ABOVE,
  REVIEW_ABOVE_SEATS,
  VOLUME_SLABS,
  authorisedRatesForItem,
  discountedRate,
  maySendUnattended,
  slabFor,
  slabLines,
} from "./volume-slabs";

/* Live catalogue figures, ₹/seat/MONTH, measured 25 Aug 2026. */
const STARTER = { msrp: 270, cost: 110 };
/** The thinnest margin in the catalogue (13.3%) — the product a deeper slab breaks first. */
const APPSHEET = { msrp: 830, cost: 720 };

describe("slabFor", () => {
  it.each([
    [1, 0], [20, 0],
    [21, 3], [50, 3],
    [51, 5], [100, 5],
  ])("gives %i seats a %i%% discount", (seats, percent) => {
    const out = slabFor(seats);
    expect(out.kind).toBe("slab");
    if (out.kind === "slab") expect(out.slab.percent).toBe(percent);
  });

  it("has no gap and no overlap between the bands", () => {
    /* A gap means some seat count silently gets no slab; an overlap means the first match
       wins and the second is dead policy nobody notices. Both are the kind of thing that
       only shows up on the one deal that lands on the boundary. */
    for (let seats = 1; seats <= CUSTOM_PRICING_ABOVE; seats++) {
      const matches = VOLUME_SLABS.filter(
        (s) => seats >= s.minSeats && (s.maxSeats === null || seats <= s.maxSeats),
      );
      expect(matches, `${seats} seats matched ${matches.length} slabs`).toHaveLength(1);
    }
  });

  it("refuses to price above the rate card, and says why", () => {
    const out = slabFor(CUSTOM_PRICING_ABOVE + 1);
    expect(out.kind).toBe("custom");
    if (out.kind === "custom") {
      expect(out.reason).toContain("person's call");
      expect(out.reason).toContain("101 seats");
    }
  });

  it.each([0, -5, 1.5, NaN])("rejects %s as a seat count", (seats) => {
    expect(slabFor(seats).kind).toBe("invalid");
  });
});

describe("maySendUnattended — the review band", () => {
  it("lets a small deal through", () => {
    expect(maySendUnattended(20)).toBe(true);
    expect(maySendUnattended(REVIEW_ABOVE_SEATS)).toBe(true);
  });

  it("holds everything above the review line, even though it is still priced", () => {
    /* The band that changed behaviour. 51–100 seats now gets a fully-priced 5% quote, and it
       still does not go out unread — a ~₹8 lakh deal on a discount policy that has never been
       exercised is not where this app should first act alone. */
    expect(maySendUnattended(REVIEW_ABOVE_SEATS + 1)).toBe(false);
    expect(maySendUnattended(100)).toBe(false);
  });

  it("holds a deal it cannot price at all", () => {
    expect(maySendUnattended(500)).toBe(false);
  });
});

describe("discountedRate — rounding", () => {
  it("rounds DOWN, so the discount delivered is never less than the one advertised", () => {
    /* 3% off 270 is 261.90. Nearest would give 262, which is a 2.96% discount sold as 3%. */
    expect(discountedRate(STARTER.msrp, 3, STARTER.cost).rate).toBe(261);
  });

  it("rounds a .5 down too, not to the nearest even or up", () => {
    /* 5% off 270 is exactly 256.50 — the case where rounding rules disagree most. */
    expect(discountedRate(STARTER.msrp, 5, STARTER.cost).rate).toBe(256);
  });

  it("never returns a fraction, because this schema stores whole rupees", () => {
    for (const pct of [3, 5]) {
      for (const list of [120, 270, 864, 990, 2400, 3240, 10368]) {
        expect(Number.isInteger(discountedRate(list, pct, 0).rate)).toBe(true);
      }
    }
  });

  it("leaves the list rate alone at 0%", () => {
    const out = discountedRate(STARTER.msrp, 0, STARTER.cost);
    expect(out.rate).toBe(270);
    expect(out.appliedPercent).toBe(0);
    expect(out.note).toBeNull();
  });

  it("works in ANY unit, which is why the slab is a percent", () => {
    /* The annual line carries msrp × 12. A rupee-valued rate card could only ever be right
       for one unit and one product — AGENTS.md L106. */
    expect(discountedRate(270 * 12, 5, 110 * 12).rate).toBe(3078);
  });
});

describe("discountedRate — the cost floor", () => {
  it("refuses the discount rather than trimming it to fit", () => {
    /* A discount of "4.1%, because that is all the margin allowed" is a number nobody agreed
       to, arrived at by a machine, in a customer's quote. */
    const out = discountedRate(1000, 30, 900);
    expect(out.rate).toBe(1000);
    expect(out.appliedPercent).toBe(0);
    expect(out.note).toContain("NOT applied");
    expect(out.note).toContain("₹900");
  });

  it("uses THIS line's cost, not a global floor", () => {
    /* THE TEST THIS MODULE EXISTS FOR. The rate card was handed over with "vendor wholesale
       cost (₹110)" as the hard rule. ₹110 is STARTER's cost. Applied globally it would
       approve selling a ₹720-cost product at ₹256 while reporting the rule honoured. */
    const starterFloor = 110;
    const appsheetAt30 = discountedRate(APPSHEET.msrp, 30, APPSHEET.cost);
    expect(appsheetAt30.rate).toBeGreaterThan(starterFloor);
    expect(appsheetAt30.appliedPercent, "must refuse on AppSheet's own ₹720 cost").toBe(0);
  });

  it("treats a cost of 0 as unknown, not as free", () => {
    /* Support and hosting SKUs record no wholesale. A 0 floor must not remove them from the
       rate card — the same call isBelowCost makes. */
    const out = discountedRate(999, 5, 0);
    expect(out.rate).toBe(949);
    expect(out.appliedPercent).toBe(5);
  });

  it("does not bite anywhere in today's catalogue at 5%", () => {
    /* Measured 25 Aug 2026 across all 20 active items; thinnest margin is AppSheet at 13.3%.
       Pinned so that adding a thin-margin SKU, or deepening a slab, turns this red instead of
       quietly shipping a below-cost quote. */
    const catalogue = [
      { msrp: 270, cost: 110 }, { msrp: 864, cost: 620 }, { msrp: 1380, cost: 1150 },
      { msrp: 2400, cost: 2050 }, { msrp: 200, cost: 165 }, { msrp: 990, cost: 820 },
      { msrp: 1900, cost: 1620 }, { msrp: 120, cost: 95 }, { msrp: 280, cost: 220 },
      { msrp: 830, cost: 720 },
    ];
    for (const item of catalogue) {
      const out = discountedRate(item.msrp, 5, item.cost);
      expect(out.appliedPercent, `5% should apply to a ₹${item.msrp} item`).toBe(5);
      expect(out.rate).toBeGreaterThanOrEqual(item.cost);
    }
  });
});

describe("what the agent is shown and allowed to say", () => {
  it("renders the rate card from the same table the quote applies", () => {
    const text = slabLines().join("\n");
    expect(text).toContain("1–20 seats: list price");
    expect(text).toContain("3% off list");
    expect(text).toContain("5% off list");
  });

  it("tells the agent to STOP above the rate card rather than improvise", () => {
    expect(slabLines().join("\n")).toContain("you may NOT quote");
  });

  it("authorises exactly the rates the quote can produce — no more", () => {
    /* Both halves matter. A rate the agent quotes correctly must not be flagged, and a rate
       the quote would never produce must not be authorised. 24 Aug: a guard fed from a
       different source than the draft approved a below-cost price. */
    const rates = authorisedRatesForItem(STARTER.msrp, STARTER.cost);
    expect(rates).toEqual(expect.arrayContaining([270, 261, 256]));
    expect(rates).toHaveLength(3);
  });

  it("never authorises a total", () => {
    /* 25 seats × ₹261. The app computes totals and hands them over as facts; the model is
       never given arithmetic. */
    expect(authorisedRatesForItem(STARTER.msrp, STARTER.cost)).not.toContain(6525);
  });

  it("authorises only the list rate when the floor blocks every discount", () => {
    const rates = authorisedRatesForItem(1000, 990);
    expect(rates).toEqual([1000]);
  });
});

describe("the discounted rate can never BE our wholesale price", () => {
  it("refuses a discount that lands exactly on cost", () => {
    /* Found by an existing test in sales-agent.test.ts, not by design: allowedMoney came back
       as a list the guard would measure a draft against, and a `<` floor would have let our own
       buying price into it for any SKU whose margin equals a slab. That test's words: quoting
       our cost to the customer is "not a rounding error, it is handing the margin to the
       buyer". Zero margin is also just not what a volume rate card is for. */
    const out = discountedRate(100, 5, 95);
    expect(out.rate).toBe(100);
    expect(out.appliedPercent).toBe(0);
    expect(out.note).toContain("no margin");
  });

  it("never emits the cost figure for any slab, at any margin", () => {
    /* Swept rather than spot-checked: every margin from 0 to 30% against every slab. One
       combination landing on cost is all it takes, and it would be the one nobody tried. */
    for (let cost = 70; cost <= 100; cost++) {
      for (const slab of VOLUME_SLABS) {
        if (slab.percent <= 0) continue;
        const out = discountedRate(100, slab.percent, cost);
        expect(
          out.rate === cost && out.appliedPercent > 0,
          `${slab.percent}% off ₹100 with cost ₹${cost} produced the cost itself`,
        ).toBe(false);
      }
    }
  });

  it("keeps the wholesale figure out of the authorised list", () => {
    expect(authorisedRatesForItem(100, 95)).not.toContain(95);
  });
});
