/**
 * /subscriptions ?focus= — the set behind the money tiles (R-118, 2 Oct 2026).
 *
 * Active MRR / ARR / Margin / Seats add up status = 'active'. No single tab is that set:
 * the folders split it into Active and Expiring (renewing within 30 days), so the tiles had
 * nowhere exact to open. The tiles and the list both use subInFocus.
 */
export const SUB_FOCI = ["", "active"] as const;
export type SubFocus = (typeof SUB_FOCI)[number];

export const SUB_FOCUS_LABEL: Record<Exclude<SubFocus, "">, string> = {
  active: "Active subscriptions — every one billing now, renewing soon included",
};

export function subInFocus(s: { status: string }, focus: SubFocus): boolean {
  if (focus === "") return true;
  return s.status === "active";
}
