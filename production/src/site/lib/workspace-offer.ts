/**
 * Google Workspace Business Starter — new-account offer (Pardeep, 4 Oct 2026).
 *
 * Our cost for a NEW (fresh) account is ₹1,650/user/year, but only from 30 users and with
 * Google's approval (usually given). Below 30 users, and at every renewal, it is ₹3,080. So
 * the offer is year 1 only, 30+ users only, sold at that cost (zero margin in year 1, earned
 * back at renewal). Every page that shows it must also say the three conditions somewhere
 * the buyer will read them: 30+ users, Google approval, list price from year 2.
 *
 * Not in the catalogue: the team quotes new 30+ accounts at this price.
 */
export const FIRST_YEAR_PER_USER = 1650;
export const OFFER_MIN_USERS = 30;

/** Percent off the yearly list price, rounded — "49" for ₹1,650 against ₹3,240. */
export function offerPercentOff(listPerUserYear: number): number {
  if (!(listPerUserYear > 0)) return 0;
  return Math.max(0, Math.round((1 - Math.min(FIRST_YEAR_PER_USER, listPerUserYear) / listPerUserYear) * 100));
}
