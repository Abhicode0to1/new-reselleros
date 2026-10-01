/**
 * Per-project P&L, booked to date (R-011, 1 Oct 2026).
 *
 * The project page's "Booked to date" line subtracted the WHOLE labour allocation —
 * e.g. 8 months of salary for a project that started 20 Apr — from what had been
 * invoiced so far. On 1 Oct only ~5.4 of those months had passed, so "profit to date"
 * was understated by the salary of months that have not happened yet.
 *
 * Here: labour to date = monthly × percent × the months of that allocation that have
 * elapsed by `today` (from its start_date, capped at its end_date and at `months`).
 * All money ex-GST, rounded to the rupee like the rest of the card.
 */

export const DAYS_PER_MONTH = 30.44;

export interface LabourLineInput {
  monthlyGross: number;
  percent: number;
  months: number;
  start_date: string | null;
  end_date: string | null;
}

function dayNum(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 864e5;
}

/**
 * Months of this allocation that have elapsed by `today` (YYYY-MM-DD, IST day).
 * No start date of its own → the project's start; neither → the full `months`
 * (nothing to measure against, so the old whole-allocation number stands).
 */
export function labourMonthsElapsed(line: LabourLineInput, today: string, projectStart: string | null): number {
  const start = line.start_date ?? projectStart;
  if (!start) return line.months;
  const endDay = line.end_date ? Math.min(dayNum(line.end_date), dayNum(today)) : dayNum(today);
  const days = endDay - dayNum(start);
  if (days <= 0) return 0;
  return Math.min(line.months, days / DAYS_PER_MONTH);
}

export function labourCost(line: LabourLineInput, months: number): number {
  return Math.round(line.monthlyGross * (line.percent / 100) * months);
}

export function labourToDate(line: LabourLineInput, today: string, projectStart: string | null): number {
  return labourCost(line, labourMonthsElapsed(line, today, projectStart));
}

export interface BookedInput {
  /** Ex-GST value of milestones already invoiced. */
  bookedRevenue: number;
  /** External costs (expenses) dated on or before today. */
  costs: { amount: number | null; expense_date: string | null }[];
  labour: LabourLineInput[];
  today: string;
  projectStart: string | null;
}

export interface BookedResult {
  costsToDate: number;
  labourToDate: number;
  profit: number;
  /** Percent of booked revenue, 0 when nothing is invoiced yet. */
  marginPct: number;
}

export function bookedToDate(i: BookedInput): BookedResult {
  const t = dayNum(i.today);
  const costsToDate = Math.round(
    i.costs.filter((c) => !c.expense_date || dayNum(c.expense_date) <= t).reduce((s, c) => s + (c.amount ?? 0), 0),
  );
  const lab = i.labour.reduce((s, l) => s + labourToDate(l, i.today, i.projectStart), 0);
  const profit = i.bookedRevenue - costsToDate - lab;
  return {
    costsToDate,
    labourToDate: lab,
    profit,
    marginPct: i.bookedRevenue > 0 ? Math.round((profit / i.bookedRevenue) * 100) : 0,
  };
}
