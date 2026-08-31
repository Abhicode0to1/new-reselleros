import { describe, it, expect } from "vitest";
import { cartTotals, cycleLabel, COUPONS, type CartLine } from "./money";

/* ─────────────────────────────────────────────────────────────────────────────
   Cart ka hisaab — handoff ke formula, aur wahi order jo paisa sahi rakhta hai:
   coupon GROSS par lagta hai (GST se pehle), GST discount ke BAAD ke subtotal par.
   Ulta karne par sarkar ka hissa galat ban jata hai — isi liye ye pin hai.
   ───────────────────────────────────────────────────────────────────────────── */

const line = (over: Partial<CartLine>): CartLine => ({
  key: "k", label: "L", detail: "", unitPrice: 100, qty: 1, unit: "item", cycle: "once", ...over,
});

describe("cart ke totals", () => {
  it("gross = Σ unitPrice × qty", () => {
    const t = cartTotals([line({ unitPrice: 165, qty: 40 }), line({ unitPrice: 899, qty: 1 })], "");
    expect(t.gross).toBe(165 * 40 + 899);
  });

  it("coupon gross par, GST discount ke baad — order maayne rakhta hai", () => {
    /* 1000 par 10%: discount 100, subtotal 900, GST 162, payable 1062.
       Agar GST pehle lagta to payable 1080 - 100 = 980... alag hota. */
    const t = cartTotals([line({ unitPrice: 1000 })], "ANUTECH10");
    expect(t.discount).toBe(100);
    expect(t.subtotal).toBe(900);
    expect(t.gst).toBeCloseTo(162);
    expect(t.payable).toBeCloseTo(1062);
  });

  it("galat coupon = koi discount nahi, error bhi nahi", () => {
    const t = cartTotals([line({})], "BOGUS50");
    expect(t.discountRate).toBe(0);
    expect(t.payable).toBeCloseTo(118);
  });

  it("coupon ka case aur space maaf hai", () => {
    expect(cartTotals([line({})], "  anutech10 ").discountRate).toBe(COUPONS.ANUTECH10);
  });

  it("recurring me sirf monthly line — yearly aur once nahi", () => {
    const t = cartTotals(
      [
        line({ unitPrice: 165, qty: 40, cycle: "monthly" }),
        line({ unitPrice: 899, cycle: "yearly" }),
        line({ unitPrice: 500, cycle: "once" }),
      ],
      "",
    );
    /* Yahi wo aankda hai jo "Then ₹X/month from next month" banata hai. Isme yearly ka
       ghusna grahak ko har mahine ka jhootha bojh dikhata. */
    expect(t.recurring).toBe(165 * 40);
  });

  it("khaali cart par sab shunya", () => {
    const t = cartTotals([], "ANUTECH10");
    expect(t.gross).toBe(0);
    expect(t.payable).toBe(0);
    expect(t.recurring).toBe(0);
  });
});

describe("cycle ke shabd", () => {
  it("teeno label", () => {
    expect(cycleLabel("monthly")).toBe("Recurring monthly");
    expect(cycleLabel("yearly")).toBe("Renews yearly");
    expect(cycleLabel("once")).toBe("One time");
  });
});
