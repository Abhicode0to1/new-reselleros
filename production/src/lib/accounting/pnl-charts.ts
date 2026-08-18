/**
 * The arithmetic behind the P&L charts — profit contribution, and the monthly trend.
 *
 * Separated from the drawing for the reason layoutWaterfall() is: a chart built on a wrong
 * number renders perfectly and nobody can see it. Recharts does the pixels; the shares and
 * the series are computed here, with tests.
 *
 * ─── WHY THE DONUT SHOWS PROFIT, NOT REVENUE ────────────────────────────────
 * A revenue donut for a reseller is close to useless: Google is ~98% of ANUTECH's book by
 * revenue, so the chart is one colour and says "you sell Google", which the owner knew.
 *
 * Profit contribution is the question worth a chart. ANUTECH's support product is 2% of
 * revenue and carries a 100% margin against Google's 36% — so it earns a share of the
 * profit several times its share of the sales. That is the fact a reseller acts on, and
 * it is invisible on a revenue chart.
 */
import { vendorLabel, type VendorLine } from "./pnl";

export interface ProfitSlice {
  vendor: string;
  label: string;
  /** ₹ gross profit — revenue less licence cost. */
  gross: number;
  /** Share of total gross profit, integer percent. */
  sharePct: number;
  /** Share of REVENUE, so the two can be compared. */
  revenueSharePct: number;
  /**
   * True when this vendor earns a bigger slice of the profit than of the sales.
   * The reason the chart exists.
   */
  punchesAbove: boolean;
}

/**
 * Profit contribution by vendor.
 *
 * ─── A LOSS-MAKING VENDOR IS DROPPED FROM THE DONUT, NOT HIDDEN ─────────────
 * A donut cannot draw a negative slice — there is no such thing as −15% of a circle. Some
 * charting code "solves" this with Math.abs, which turns a loss into a healthy-looking
 * wedge. Negative vendors are excluded from the ring and returned separately so the
 * caller can state them in words, which is the only honest rendering of a loss on a
 * pie chart.
 */
export function profitContribution(vendors: readonly VendorLine[]): {
  slices: ProfitSlice[];
  /** Vendors losing money — never drawn as a slice. */
  losing: { vendor: string; label: string; gross: number }[];
  totalGross: number;
} {
  const losing = vendors
    .filter((v) => v.gross < 0)
    .map((v) => ({ vendor: v.vendor, label: v.label, gross: v.gross }));

  const positive = vendors.filter((v) => v.gross > 0);
  const totalGross = positive.reduce((s, v) => s + v.gross, 0);
  const totalRevenue = vendors.reduce((s, v) => s + v.revenue, 0);

  const slices = positive
    .map((v) => {
      const sharePct = totalGross > 0 ? Math.round((v.gross / totalGross) * 100) : 0;
      const revenueSharePct = totalRevenue > 0 ? Math.round((v.revenue / totalRevenue) * 100) : 0;
      return {
        vendor: v.vendor,
        label: vendorLabel(v.vendor),
        gross: v.gross,
        sharePct,
        revenueSharePct,
        /* A one-point difference is rounding, not a signal. */
        punchesAbove: sharePct > revenueSharePct + 1,
      };
    })
    .sort((a, b) => b.gross - a.gross);

  return { slices, losing, totalGross };
}

/* ─── MONTH-ON-MONTH ──────────────────────────────────────────────────────── */

export interface MonthPoint {
  /** `2026-04`. */
  key: string;
  /** `Apr` — the axis label. */
  label: string;
  revenue: number;
  cogs: number;
  expenses: number;
  /** revenue − cogs − expenses. */
  netProfit: number;
  /**
   * Net margin as an integer percent, or null.
   *
   * Null on a month with no revenue — NOT 0. A month where nothing was invoiced but
   * salaries were still paid has a hugely negative "margin" that is arithmetically true
   * and visually a cliff; plotting it drags the whole line off the chart and makes the
   * eleven months that matter unreadable. Recharts skips a null point and joins the line
   * across it, which is the right picture: no sales, no margin to speak of.
   */
  marginPct: number | null;
  /** True when this month has not finished yet. */
  partial: boolean;
}

export interface MonthlyRow {
  /** YYYY-MM-DD. */
  date: string;
  amount: number;
}

/** The twelve months of an Indian FY, Apr → Mar. */
export function fyMonths(fyStartYear: number): { key: string; label: string }[] {
  const NAMES = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
  return NAMES.map((label, i) => {
    const month = ((3 + i) % 12) + 1;              // 4..12, then 1..3
    const year = 3 + i < 12 ? fyStartYear : fyStartYear + 1;
    return { key: `${year}-${String(month).padStart(2, "0")}`, label };
  });
}

/**
 * Roll revenue and expenses into a twelve-month series.
 *
 * `cogsRatio` is the subscription book's wholesale-to-price ratio — the same figure
 * buildPnl() uses when no vendor bills exist. Applying it per month keeps every point on
 * the chart consistent with the headline above it; deriving the monthly cost any other
 * way would give a trend line that disagrees with the waterfall.
 *
 * Months after `today` are omitted entirely rather than plotted as zero. A line falling to
 * the floor for the rest of the financial year is a picture of a business that has
 * stopped, and it is the first thing the eye goes to.
 */
export function monthlySeries(args: {
  fyStartYear: number;
  revenue: readonly MonthlyRow[];
  expenses: readonly MonthlyRow[];
  cogsRatio: number;
  /** YYYY-MM-DD, IST. */
  today: string;
}): MonthPoint[] {
  const { fyStartYear, revenue, expenses, cogsRatio, today } = args;
  const thisMonth = today.slice(0, 7);

  const sumBy = (rows: readonly MonthlyRow[]) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = r.date.slice(0, 7);
      m.set(k, (m.get(k) ?? 0) + r.amount);
    }
    return m;
  };
  const rev = sumBy(revenue);
  const exp = sumBy(expenses);

  return fyMonths(fyStartYear)
    .filter((m) => m.key <= thisMonth)
    .map((m) => {
      const r = rev.get(m.key) ?? 0;
      const cogs = Math.round(r * cogsRatio);
      const e = exp.get(m.key) ?? 0;
      const netProfit = r - cogs - e;
      return {
        key: m.key,
        label: m.label,
        revenue: r,
        cogs,
        expenses: e,
        netProfit,
        marginPct: r > 0 ? Math.round((netProfit / r) * 100) : null,
        partial: m.key === thisMonth,
      };
    });
}

/** Best and worst months by net profit — the two a reader should be pointed at. */
export function trendHighlights(points: readonly MonthPoint[]): {
  best: MonthPoint | null;
  worst: MonthPoint | null;
  /** Months that lost money. */
  lossMonths: number;
} {
  /* Two exclusions, both found by reading the live chart rather than by reasoning:

     A part-month, because it is not finished — calling it the worst month of the year is
     a judgement on data that has not arrived.

     A month with NO ACTIVITY AT ALL. The live page said "Best month so far was May at ₹0
     net" while three other months lost money. Arithmetically true and useless: May had no
     invoices and no expenses, so it was not a good month, it was an empty one. A month
     where nothing happened is not a business result and must not win the comparison. */
  const done = points.filter((p) => !p.partial && (p.revenue !== 0 || p.expenses !== 0));
  if (done.length === 0) return { best: null, worst: null, lossMonths: 0 };

  let best = done[0], worst = done[0];
  for (const p of done) {
    if (p.netProfit > best.netProfit) best = p;
    if (p.netProfit < worst.netProfit) worst = p;
  }
  return { best, worst, lossMonths: done.filter((p) => p.netProfit < 0).length };
}
