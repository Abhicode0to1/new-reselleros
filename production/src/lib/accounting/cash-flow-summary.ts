/**
 * Cash-flow month rows and runway — the two numbers the page used to get misleading.
 *
 * ─── MONTH-END BALANCE, NOT A CUMULATIVE FROM ZERO ──────────────────────────
 * The table ended on "−₹1,55,371" while the bank held ₹1,44,930 — a running total that
 * started at 0 reads as an overdrawn account. Each month now ends on the balance the
 * statement shows: opening balances + every line up to that month's end, the same sum
 * bank_account_current_balance() makes.
 *
 * ─── RUNWAY: TWO HONEST NUMBERS, NOT ONE HALF-NUMBER ────────────────────────
 * The old figure averaged the net of LOSS months only — Jul and Aug's ₹10.8L of receipts
 * simply dropped out — so it was neither "if nothing comes in" nor "at the current trend".
 * Now both are stated, over every month in the span (a quiet month counts as a month):
 *   - ifNoIncome: cash ÷ average monthly spend      — the floor, if receipts stop;
 *   - atTrend:    cash ÷ average monthly net burn   — null when cash is growing.
 */

export interface FlowLine { txn_date: string; credit: number; debit: number }

export interface MonthRow {
  ym: string;
  cashIn: number;
  cashOut: number;
  net: number;
  /** Balance at the end of the month across the accounts, as the statement shows it. */
  balanceEnd: number;
}

/** "2026-04" .. "2026-09" inclusive — quiet months included, so averages are per calendar month. */
export function monthSpan(first: string, last: string): string[] {
  const out: string[] = [];
  let [y, m] = first.split("-").map(Number);
  const [ly, lm] = last.split("-").map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/**
 * @param balanceBefore balance before the first line in `lines` — opening balances plus every
 *                      line dated before the range.
 */
export function monthRows(lines: readonly FlowLine[], balanceBefore: number): MonthRow[] {
  if (lines.length === 0) return [];
  const agg = new Map<string, { cashIn: number; cashOut: number }>();
  for (const l of lines) {
    const ym = l.txn_date.slice(0, 7);
    const g = agg.get(ym) ?? { cashIn: 0, cashOut: 0 };
    g.cashIn += l.credit; g.cashOut += l.debit;
    agg.set(ym, g);
  }
  const keys = [...agg.keys()].sort();
  let bal = balanceBefore;
  return monthSpan(keys[0], keys[keys.length - 1]).map((ym) => {
    const g = agg.get(ym) ?? { cashIn: 0, cashOut: 0 };
    const net = g.cashIn - g.cashOut;
    bal += net;
    return { ym, cashIn: g.cashIn, cashOut: g.cashOut, net, balanceEnd: bal };
  });
}

export interface Runway {
  months: number;
  /** Average monthly cash out. */
  spendPerMonth: number;
  /** Average monthly net (negative = burning). */
  netPerMonth: number;
  /** cash ÷ spend — how long it lasts if nothing comes in. Null when there is no spend. */
  ifNoIncome: number | null;
  /** cash ÷ net burn — how long at the span's trend. Null when cash is not falling. */
  atTrend: number | null;
}

export function runway(rows: readonly MonthRow[], cash: number): Runway | null {
  if (rows.length === 0) return null;
  const n = rows.length;
  const spendPerMonth = Math.round(rows.reduce((s, r) => s + r.cashOut, 0) / n);
  const netPerMonth = Math.round(rows.reduce((s, r) => s + r.net, 0) / n);
  const last = (per: number) => (cash > 0 ? Math.round((cash / per) * 10) / 10 : 0);
  return {
    months: n,
    spendPerMonth,
    netPerMonth,
    ifNoIncome: spendPerMonth > 0 ? last(spendPerMonth) : null,
    atTrend: netPerMonth < 0 ? last(-netPerMonth) : null,
  };
}
