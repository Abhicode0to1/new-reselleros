/**
 * Deal rows for /today (30 Sep 2026) — the pipeline's "aaj kya karna hai".
 *
 * today_inbox() is SQL and adding a branch there needs a migration; these three signals
 * come from the leads the page already reads, so they are built here, placed on the SAME
 * priority scale (migration 20260928160000, header), and merged by rankTodayItems.
 *
 *   deal_overdue     open deal, expected_close_date before IST today      65  should be answered today
 *   deal_quote_stale stage quote for ≥7 IST days, no follow-up since      60
 *   deal_closing     open deal, expected close in the next 7 IST days     50  today, nothing breaks yet
 *
 * One row per deal: a deal that is overdue AND a stale quote shows once, as the more urgent
 * of the two — two rows about the same lead is noise.
 *
 * "Follow-up" = any lead_activities row after the deal entered quote, EXCEPT kind 'stage':
 * the quote-send route writes a 'stage' row at the moment it moves the lead to Quote Sent,
 * and that is the quote itself, not a follow-up on it. When the caller has no activity
 * data, pass null and the quote's age alone decides.
 */
import type { TodayItem } from "@/lib/today/inbox";
import { isOpenDeal, type DealRow } from "@/lib/deals/pipeline-summary";
import { istToday, toIstDate, addDaysISO, daysBetweenISO } from "@/lib/dates/ist";
import { rupee } from "@/lib/utils";

export const QUOTE_STALE_DAYS = 7;
export const CLOSING_WINDOW_DAYS = 7;
/** Same cap as each today_inbox() branch. */
export const DEAL_KIND_CAP = 50;

export const DEAL_PRIORITY = { deal_overdue: 65, deal_quote_stale: 60, deal_closing: 50 } as const;

/** Midnight IST of a YYYY-MM-DD date, as an ISO instant. */
function istMidnightISO(date: string): string {
  return new Date(`${date.slice(0, 10)}T00:00:00+05:30`).toISOString();
}

const money = (v: number | null) => (v && v > 0 ? ` · ${rupee(v, { compact: true })}` : "");

/**
 * @param lastFollowUp lead id → ISO instant of its latest non-'stage' activity, or null
 *                     when activity data is not available (age alone then decides).
 */
export function dealTodayItems(
  rows: readonly DealRow[],
  lastFollowUp: ReadonlyMap<string, string> | null,
  now: Date = new Date(),
): TodayItem[] {
  const today = istToday(now);
  const weekEnd = addDaysISO(today, CLOSING_WINDOW_DAYS - 1);
  const buckets: Record<keyof typeof DEAL_PRIORITY, TodayItem[]> = {
    deal_overdue: [], deal_quote_stale: [], deal_closing: [],
  };

  for (const d of rows) {
    if (!isOpenDeal(d)) continue;
    const href = `/deals?lead=${d.id}`;
    const close = d.expected_close_date?.slice(0, 10) ?? null;

    if (close && close < today) {
      const late = daysBetweenISO(close, today);
      buckets.deal_overdue.push({
        kind: "deal_overdue", id: d.id, href,
        title: `${d.company} — close date passed (${late}d)${money(d.value)}`,
        due_at: istMidnightISO(close), priority: DEAL_PRIORITY.deal_overdue,
      });
      continue;
    }

    if (d.stage === "quote" && d.stage_changed_at) {
      const quotedOn = toIstDate(d.stage_changed_at);
      const age = daysBetweenISO(quotedOn, today);
      const followed = lastFollowUp?.get(d.id);
      const noFollowUp = !followed || Date.parse(followed) <= Date.parse(d.stage_changed_at);
      if (age >= QUOTE_STALE_DAYS && noFollowUp) {
        buckets.deal_quote_stale.push({
          kind: "deal_quote_stale", id: d.id, href,
          title: `${d.company} — quote sent ${age}d ago, no follow-up${money(d.value)}`,
          due_at: istMidnightISO(addDaysISO(quotedOn, QUOTE_STALE_DAYS)),
          priority: DEAL_PRIORITY.deal_quote_stale,
        });
        continue;
      }
    }

    if (close && close >= today && close <= weekEnd) {
      buckets.deal_closing.push({
        kind: "deal_closing", id: d.id, href,
        title: `${d.company} — closing this week${money(d.value)}`,
        due_at: istMidnightISO(close), priority: DEAL_PRIORITY.deal_closing,
      });
    }
  }

  const byDue = (a: TodayItem, b: TodayItem) => (a.due_at ?? "").localeCompare(b.due_at ?? "") || a.id.localeCompare(b.id);
  return [
    ...buckets.deal_overdue.sort(byDue).slice(0, DEAL_KIND_CAP),
    ...buckets.deal_quote_stale.sort(byDue).slice(0, DEAL_KIND_CAP),
    ...buckets.deal_closing.sort(byDue).slice(0, DEAL_KIND_CAP),
  ];
}

/**
 * lead id → latest follow-up instant, from lead_activities rows. 'stage' rows are skipped
 * (see the header).
 */
export function latestFollowUps(
  acts: readonly { lead_id: string; created_at: string; kind: string }[],
): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of acts) {
    if (a.kind === "stage") continue;
    const prev = m.get(a.lead_id);
    if (!prev || Date.parse(a.created_at) > Date.parse(prev)) m.set(a.lead_id, a.created_at);
  }
  return m;
}
