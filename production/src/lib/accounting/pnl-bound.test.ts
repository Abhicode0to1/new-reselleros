import { describe, it, expect } from "vitest";
import { netProfitView } from "./pnl-bound";

describe("netProfitView", () => {
  it("known net profit is passed through, profit or loss", () => {
    expect(netProfitView({ netProfit: 12000, revenue: 100000, expenses: 50000 })).toEqual({ kind: "known", value: 12000 });
    expect(netProfitView({ netProfit: -3000, revenue: 100000, expenses: 50000 })).toEqual({ kind: "known", value: -3000 });
  });

  it("cost of goods unknown, expenses above revenue: a loss of at least the gap (the real Jul–Sep case)", () => {
    expect(netProfitView({ netProfit: null, revenue: 457627, expenses: 882762 })).toEqual({ kind: "loss-at-least", value: 425135 });
  });

  it("cost of goods unknown, revenue above expenses: only a ceiling", () => {
    expect(netProfitView({ netProfit: null, revenue: 457627, expenses: 176737 })).toEqual({ kind: "profit-at-most", value: 280890 });
  });
});
