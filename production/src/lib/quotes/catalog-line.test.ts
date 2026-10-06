import { describe, it, expect } from "vitest";
import { catalogYearlyPrice, lineFromCatalog } from "./catalog-line";

describe("catalog → quote line (2 Oct 2026)", () => {
  it("a monthly-priced licence is ₹/mo × 12", () => {
    expect(catalogYearlyPrice({ msrp: 136, wholesale: 110, prices: {} } as never)).toEqual({ rate: 1632, cost: 1320 });
  });
  it("the annual tier wins over msrp", () => {
    expect(catalogYearlyPrice({ msrp: 170, wholesale: 140, prices: { annual: { msrp: 136, wholesale: 110 } } } as never)).toEqual({ rate: 1632, cost: 1320 });
  });
  it("a yearly-total plan is used verbatim — never a ₹0 line", () => {
    expect(catalogYearlyPrice({ msrp: 0, wholesale: 0, prices: { annual_total: { msrp: 9996, wholesale: 0 } } } as never)).toEqual({ rate: 9996, cost: 0 });
  });
  it("support defaults to one, a licence to ten, an explicit qty wins", () => {
    const sup = lineFromCatalog({ id: "SUP-GW-STR-t-YR", name: "S", vendor: "support", msrp: 0, wholesale: 0, prices: { annual_total: { msrp: 9996 } } } as never);
    expect(sup.qty).toBe(1);
    expect(sup.rate).toBe(9996);
    const lic = lineFromCatalog({ id: "GW-STR-t", name: "G", vendor: "google", msrp: 136, wholesale: 110, prices: {} } as never);
    expect(lic.qty).toBe(10);
    expect(lineFromCatalog({ id: "GW-STR-t", name: "G", vendor: "google", msrp: 136, wholesale: 110, prices: {} } as never, { qty: 25 }).qty).toBe(25);
  });
});
