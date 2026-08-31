import { describe, it, expect } from "vitest";
import { buildWorkspaceFlexLines, buildWorkspaceLines, type CatalogPriceRow } from "./workspace";

/* ─────────────────────────────────────────────────────────────────────────────
   FLEX = PAY-AS-YOU-GO. Pardeep, 31 Aug 2026: "flex pricing me monthly commitment wala
   rate aata hai … isme 12 invoices wala koi chakkar nahi."

   Do cheezein pin hain, aur dono ki keemat ye app pehle de chuka hai:

   1. KAHIN ×12 NAHI — flex ka subtotal EK MAHINE ka hota hai. Annual rate ko mahine ka
      keh dena (ya ulta) wahi 12× ki galti hai jo Q-0027 par ho chuki thi.
   2. DAAM GADHA NAHI JATA — catalogue me flexible daam nahi to NULL milta hai, annual
      se koi jugaad nahi banta. Null par route draft ko aadmi ke paas rok deta hai.
   ───────────────────────────────────────────────────────────────────────────── */

/** Bilkul aaj ka live catalogue row (31 Aug 2026): annual 270, flex 325. */
const LIVE_ROW: CatalogPriceRow = {
  id: "itm-1",
  name: "Google Workspace Business Starter",
  msrp: 270,
  wholesale: 250,
  prices: {
    annual: { msrp: 270, wholesale: 250 },
    monthly: { msrp: 325, wholesale: 300 },
  },
};

describe("flex lines — mahine ka hisaab, mahine ka hi", () => {
  it("20 seats × ₹325 = ₹6,500/mahina, GST ke saath ₹7,670 — ₹78,000 NAHI", () => {
    const flex = buildWorkspaceFlexLines(LIVE_ROW, "starter", 20);
    expect(flex).not.toBeNull();
    expect(flex!.items[0].rate).toBe(325);
    expect(flex!.items[0].commitment).toBe("monthly");
    expect(flex!.subtotal).toBe(6_500);
    expect(flex!.amount).toBe(7_670);
    /* CONTROL — yahi assert is test ka dil hai: kahin chupke se ×12 hua to subtotal
       78,000 ban jata. */
    expect(flex!.subtotal).not.toBe(6_500 * 12);
  });

  it("annual wala hisaab flex se alag hai aur alag hi rehna chahiye", () => {
    const annual = buildWorkspaceLines(LIVE_ROW, "starter", 20);
    expect(annual.items[0].rate).toBe(270 * 12);          // ₹/seat/YEAR
    expect(annual.items[0].commitment).toBe("annual_yearly");
    expect(annual.subtotal).toBe(64_800);
    /* Dono ek document par kabhi mix nahi hote — route `chosen` se EK chunta hai. */
  });

  it("flex ka wholesale bhi mahine ka (300), annual ka nahi", () => {
    const flex = buildWorkspaceFlexLines(LIVE_ROW, "starter", 20)!;
    expect(flex.items[0].cost).toBe(300);
  });
});

describe("daam gadha nahi jata", () => {
  it("catalogue me flexible tier nahi → NULL, annual se koi jugaad nahi", () => {
    const noFlex: CatalogPriceRow = { ...LIVE_ROW, prices: { annual: { msrp: 270, wholesale: 250 } } };
    expect(buildWorkspaceFlexLines(noFlex, "starter", 20)).toBeNull();
  });

  it("flex msrp 0 ya kachra → NULL", () => {
    const zero: CatalogPriceRow = { ...LIVE_ROW, prices: { monthly: { msrp: 0, wholesale: 0 } } };
    expect(buildWorkspaceFlexLines(zero, "starter", 20)).toBeNull();
    expect(buildWorkspaceFlexLines(null, "starter", 20)).toBeNull();
  });

  it("wholesale na ho to cost 0 — daam phir bhi bante hain (margin report hi kam batayegi)", () => {
    const noWholesale: CatalogPriceRow = { ...LIVE_ROW, prices: { monthly: { msrp: 325, wholesale: 0 } } };
    const flex = buildWorkspaceFlexLines(noWholesale, "starter", 20)!;
    expect(flex.items[0].cost).toBe(0);
    expect(flex.items[0].rate).toBe(325);
  });
});
