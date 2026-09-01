/**
 * Renewals FORECAST — agle mahino me renewal par kitna paisa aana chahiye
 * (audit B7: /renewals ek list thi, curve nahi — "is quarter kitna aayega?"
 * ka jawab haath se jodna padta tha).
 *
 * Ganit jaan-boojh kar seedha hai, aur seemayein LIKHI hui hain:
 *   - ANNUAL sub ka renewal-invoice ≈ mrr × 12 (wahi ulta ganit jo
 *     record_payment karta hai: mrr = line/12; ₹1-2 ka rounding pehle se
 *     wahan darj hai).
 *   - FLEX (renewal har mahine) forecast me NAHI ginta — wo run-rate hai,
 *     renewal-event nahi; use alag line me dikhate hain taki 12× dono
 *     disha me na ho (aaj hi ke B9 ka sabak).
 *   - Ye ANDAZA hai: churn/expansion nahi ginta, aur screen yahi kehta hai.
 */
import type { Subscription } from "@/lib/supabase/database.types";

export interface ForecastMonth {
  /** "2026-09" */
  key: string;
  /** "Sep 2026" */
  label: string;
  /** ₹ — annual renewals ka expected invoice-value (ex-GST, mrr×12). */
  amount: number;
  count: number;
}

export interface RenewalForecast {
  months: ForecastMonth[];
  totalAmount: number;
  totalCount: number;
  /** Flex subs ka mahina-war run-rate — alag, jod me NAHI. */
  flexMonthlyRunRate: number;
  flexCount: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * @param todayISO IST ki aaj ki tareekh (YYYY-MM-DD) — caller deta hai,
 *                 taki ye function pure aur test me jamaya hua rahe.
 */
export function renewalForecast(
  subs: readonly Subscription[],
  todayISO: string,
  horizonMonths = 6,
): RenewalForecast {
  const start = todayISO.slice(0, 7); // "2026-09"
  const keys: string[] = [];
  {
    let [y, m] = start.split("-").map(Number);
    for (let i = 0; i < horizonMonths; i++) {
      keys.push(`${y}-${String(m).padStart(2, "0")}`);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  }

  const byKey = new Map<string, ForecastMonth>(
    keys.map((key) => {
      const [y, m] = key.split("-").map(Number);
      return [key, { key, label: `${MONTHS[m - 1]} ${y}`, amount: 0, count: 0 }];
    }),
  );

  let flexMonthlyRunRate = 0;
  let flexCount = 0;

  for (const sub of subs) {
    if (sub.status !== "active") continue;
    /* Term 1 mahine ka = flex (record_payment yahi likhta hai). */
    const isFlex = (sub.term_months ?? 12) <= 1;
    if (isFlex) {
      flexMonthlyRunRate += sub.mrr;
      flexCount += 1;
      continue;
    }
    const renewal = sub.renewal_date?.slice(0, 7);
    if (!renewal) continue;
    const bucket = byKey.get(renewal);
    if (!bucket) continue; // horizon ke bahar (ya beeta hua — wo overdue list ka kaam hai)
    bucket.amount += sub.mrr * 12;
    bucket.count += 1;
  }

  const months = keys.map((k) => byKey.get(k)!);
  return {
    months,
    totalAmount: months.reduce((s, m) => s + m.amount, 0),
    totalCount: months.reduce((s, m) => s + m.count, 0),
    flexMonthlyRunRate,
    flexCount,
  };
}
