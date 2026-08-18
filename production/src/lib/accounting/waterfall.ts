/**
 * Laying out a waterfall — the geometry, separated from the drawing.
 *
 * ─── WHY THIS IS A PURE FUNCTION AND NOT JUST JSX ───────────────────────────
 * A waterfall's whole meaning is in where each bar STARTS. Get the running total wrong
 * and the chart still renders beautifully, with bars floating at plausible heights, and
 * nobody can tell by looking. That is a bug you can only catch with arithmetic, so the
 * arithmetic lives here with tests and the component only draws what it is handed.
 *
 * ─── AND WHY NOT RECHARTS ───────────────────────────────────────────────────
 * Recharts is already a dependency and has no waterfall. The usual workaround is a
 * stacked BarChart with an invisible base series — which means the "cost" bar is really
 * two bars, one of them a lie told to the layout engine, and the tooltip then has to be
 * taught to hide it. An inline SVG is fewer moving parts and exact.
 *
 * ─── SIGNS ──────────────────────────────────────────────────────────────────
 * `delta` is signed: revenue is positive, COGS and expenses are negative. Totals
 * (`isTotal`) do not move the running balance — they RESTATE it, which is what makes
 * Gross Margin and Net Profit render as full columns from the axis rather than as
 * floating steps.
 */

export interface WaterfallInput {
  key: string;
  label: string;
  /** ₹, signed. Ignored when `isTotal`. */
  delta: number;
  /** A subtotal: draws from zero and restates the running balance. */
  isTotal?: boolean;
  /** Shown under the bar. */
  hint?: string | null;
  /** Set when the figure is not a fact — renders hatched. */
  estimated?: boolean;
}

export interface WaterfallBar extends WaterfallInput {
  /** Running total BEFORE this bar. */
  start: number;
  /** Running total AFTER it. */
  end: number;
  /** ₹ height of the bar — always positive. */
  magnitude: number;
  /** Fraction of the chart's height, 0–1. */
  heightFrac: number;
  /** Fraction from the BOTTOM of the plot to the bar's base, 0–1. */
  baseFrac: number;
  direction: "up" | "down" | "total";
}

export interface WaterfallLayout {
  bars: WaterfallBar[];
  /** Highest running total reached — the top of the plot. */
  max: number;
  /** Lowest, which is 0 unless the business lost money. */
  min: number;
  /** Where ₹0 sits as a fraction from the bottom. 0 unless `min` is negative. */
  zeroFrac: number;
}

/**
 * Position every bar.
 *
 * The scale spans min..max across the FULL plot height, so a loss renders below the zero
 * line rather than being clipped to nothing. A chart that cannot draw a negative net
 * profit is a chart that hides the only month anybody needed to look at.
 */
export function layoutWaterfall(steps: readonly WaterfallInput[]): WaterfallLayout {
  let running = 0;
  const raw: Omit<WaterfallBar, "heightFrac" | "baseFrac">[] = [];

  for (const s of steps) {
    if (s.isTotal) {
      raw.push({
        ...s, start: 0, end: running,
        magnitude: Math.abs(running),
        direction: "total",
      });
      continue;
    }
    const start = running;
    running += s.delta;
    raw.push({
      ...s, start, end: running,
      magnitude: Math.abs(s.delta),
      direction: s.delta >= 0 ? "up" : "down",
    });
  }

  const points = raw.flatMap((b) => [b.start, b.end, 0]);
  const max = Math.max(...points);
  const min = Math.min(...points);
  /* A flat, all-zero chart would divide by zero. Falling back to 1 draws nothing, which
     is the honest picture of a period with no money in it. */
  const span = max - min || 1;

  return {
    max, min,
    zeroFrac: (0 - min) / span,
    bars: raw.map((b) => {
      const lo = Math.min(b.start, b.end);
      const hi = Math.max(b.start, b.end);
      return {
        ...b,
        heightFrac: (hi - lo) / span,
        baseFrac: (lo - min) / span,
      };
    }),
  };
}

/**
 * Build the reseller's money story: what came in, what the licences cost, what is left,
 * what the business spent, what remains.
 *
 * Returns null when the gross margin is unknown. A waterfall implies every step is known
 * — that is what the shape says — so drawing one over a missing COGS would be the same
 * confident lie the numbers version told, only prettier.
 */
export function pnlWaterfall(p: {
  revenue: number;
  cogs: number;
  cogsBasis: "billed" | "estimated" | "unknown";
  grossMargin: number | null;
  expenses: number;
  netProfit: number | null;
}): WaterfallInput[] | null {
  if (p.grossMargin === null || p.netProfit === null) return null;

  return [
    { key: "revenue", label: "Revenue", delta: p.revenue, hint: "Invoiced to customers" },
    {
      key: "cogs", label: "Licence cost", delta: -p.cogs,
      hint: p.cogsBasis === "estimated" ? "Estimated from wholesale rates" : "Paid to vendors",
      estimated: p.cogsBasis === "estimated",
    },
    { key: "gross", label: "Gross margin", delta: 0, isTotal: true, hint: "What resale earns" },
    { key: "opex", label: "Running costs", delta: -p.expenses, hint: "Salaries, hosting, office" },
    { key: "net", label: "Net profit", delta: 0, isTotal: true, hint: "What the business kept" },
  ];
}
