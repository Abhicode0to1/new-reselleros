/**
 * GST return periods — IST calendar months and quarters (WC-gst, 30 Sep 2026).
 *
 * A return period is an Indian calendar month. The GST page built its quick ranges from a
 * hand-rolled `new Date(Date.now() + 5.5h)`; this is the same thing on lib/dates/ist.ts so
 * it is tested once: at 00:30 IST on 1 Oct the browser's UTC clock still says 30 Sep, and
 * "this month" must already be October.
 */
import { addDaysISO, istDayStartUtc, istMonth, istParts, monthBounds } from "@/lib/dates/ist";

export interface GstPeriod { from: string; to: string; label: string }

const pad2 = (n: number) => String(n).padStart(2, "0");

/** A whole month, "2026-09" → { from: "2026-09-01", to: "2026-09-30", label: "September 2026" }. */
export function gstMonth(ym: string): GstPeriod {
  const b = monthBounds(ym);
  const label = new Date(`${b.start}T00:00:00Z`).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
  return { from: b.start, to: b.end, label };
}

/** The current IST month. */
export function gstThisMonth(now: Date = new Date()): GstPeriod {
  return gstMonth(istMonth(now));
}

/** The previous IST month (the one usually being filed). */
export function gstLastMonth(now: Date = new Date()): GstPeriod {
  return gstMonth(addDaysISO(monthBounds(istMonth(now)).start, -1).slice(0, 7));
}

/** The current IST calendar quarter (QRMP filers). */
export function gstThisQuarter(now: Date = new Date()): GstPeriod {
  const { year, month } = istParts(now);
  const q = Math.floor((month - 1) / 3);
  const first = monthBounds(`${year}-${pad2(q * 3 + 1)}`);
  const last = monthBounds(`${year}-${pad2(q * 3 + 3)}`);
  return { from: first.start, to: last.end, label: `Q${q + 1} ${year}` };
}

/** Timestamp bounds (UTC instants) of an IST date range — for filtering a timestamptz
 *  column such as payments.received_at: `gte(fromUtc)` and `lt(toUtcExclusive)`. */
export function istRangeUtc(from: string, to: string): { fromUtc: string; toUtcExclusive: string } {
  return {
    fromUtc: istDayStartUtc(from).toISOString(),
    toUtcExclusive: istDayStartUtc(addDaysISO(to, 1)).toISOString(),
  };
}
