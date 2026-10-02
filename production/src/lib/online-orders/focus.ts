/**
 * /online-orders ?focus= — the set behind each KPI tile (R-118, 2 Oct 2026).
 *
 * Tiles count with these and the table filters with them, so a click shows the orders the
 * tile counted. Two counts were also off before: "New today" matched a display string
 * ("02 Oct") and "Revenue MTD" took the UTC month — both now read the IST calendar.
 */
import { istMonth, istToday, toIstDate } from "@/lib/dates/ist";

export const ORDER_FOCI = ["", "today", "provisioning", "issue", "converting", "revenue-month"] as const;
export type OrderFocus = (typeof ORDER_FOCI)[number];

export const ORDER_FOCUS_LABEL: Record<Exclude<OrderFocus, "">, string> = {
  today: "New today",
  provisioning: "Provisioning — paid, being set up",
  issue: "Issues — needs attention",
  converting: "Trials converting to paid",
  "revenue-month": "Paid this month",
};

export interface FocusOrder { status: string; type: string; paid: boolean; createdIso: string | null }

export function orderInFocus(o: FocusOrder, focus: OrderFocus, now: Date = new Date()): boolean {
  switch (focus) {
    case "": return true;
    case "today": return !!o.createdIso && toIstDate(o.createdIso) === istToday(now);
    case "provisioning": return o.status === "provisioning";
    case "issue": return o.status === "issue";
    case "converting": return o.type === "trial" && o.status === "trial-converting";
    case "revenue-month": return o.paid && !!o.createdIso && toIstDate(o.createdIso).slice(0, 7) === istMonth(now);
  }
}
