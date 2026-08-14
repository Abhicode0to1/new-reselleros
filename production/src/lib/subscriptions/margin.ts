/**
 * Gross margin on a subscription, and detecting when a vendor price rise has
 * eaten it.
 *
 * ─── WHY THIS COULD NOT HAVE BEEN BUILT ON THE OLD NUMBERS ──────────────────
 * add-seats.ts derives cost as `sellPrice × 0.83` — a hardcoded 17% margin. A
 * margin detector fed that can never fire: margin would be exactly 17% for every
 * product forever, so nothing is ever thin and nothing is ever a loss.
 *
 * The real cost has been in the catalog the whole time. `items.prices.annual.wholesale`
 * is ₹/seat/month, and the margins in this tenant's own data are nowhere near 17%:
 *
 *     Google Workspace Business Starter   270 / 110   59.3%
 *     Google Workspace Standard           864 / 620   28.2%
 *     Google Workspace Plus             1,380 / 1,150 16.7%
 *     Google Workspace Enterprise       2,400 / 2,050 14.6%
 *     Microsoft 365 Business Premium    1,900 / 1,620 14.7%
 *
 * So 0.83 understates Business Starter by 42 points and overstates Enterprise. A
 * detector built on it would have reported healthy margins on loss-making lines.
 * This module reads the catalog.
 *
 * ─── THE UNIT, WHICH IS EASY TO GET 12× WRONG ───────────────────────────────
 * Confirmed in lib/pricing/workspace.ts, not assumed:
 *     items.prices.annual.wholesale   ₹/seat/MONTH  (resolveMonthlyCost)
 *     buildWorkspaceLines             × 12 for the year
 *     subscriptions.mrr               ₹/month for the WHOLE subscription
 * Per-seat sell is therefore mrr ÷ seats, and it is compared against a per-seat
 * MONTHLY cost. Everything here is integer paise.
 *
 * ─── PERCENTAGES ARE BASIS POINTS ───────────────────────────────────────────
 * 5930 = 59.30%. An integer, so a margin can be stored, compared and totalled
 * without a float appearing in a number someone will act on.
 */
import { type Paise } from "./proration";

/** Integer basis points. 10000 = 100.00%. */
export type Bps = number;

/**
 * Vendors whose products we BUY and resell — a zero cost against one of these is
 * missing data, not a 100% margin.
 *
 * The distinction matters because `items.wholesale` is 0 for two completely
 * different reasons in this tenant's data: hosting/support/one-off work are the
 * reseller's OWN services with no vendor cost (genuinely 100%), while a Google or
 * Microsoft line at zero cost simply has not been filled in. Reporting the second
 * as "100% margin" would put the healthiest number in the app on the row we know
 * least about.
 */
const RESOLD_VENDORS = new Set(["google", "microsoft", "zoho"]);

export type MarginStatus = "loss" | "thin" | "healthy" | "unknown";

/**
 * Below this, a margin is "thin". 10% is a PLACEHOLDER, not a considered figure —
 * it is exported so the number lives in one visible place until the operator says
 * what theirs is, rather than being buried in a comparison somewhere.
 */
export const THIN_MARGIN_BPS: Bps = 1_000;

export interface MarginInput {
  /** What the customer pays per seat per month, in paise. */
  sellPerSeatMonthPaise: Paise;
  /** What the vendor charges per seat per month, in paise. 0 = none recorded. */
  costPerSeatMonthPaise: Paise;
  seats: number;
  /** For deciding whether a zero cost means "own service" or "unknown". */
  vendor: string | null | undefined;
  /** Margin below which to call it thin. Defaults to THIN_MARGIN_BPS. */
  thinBelowBps?: Bps;
}

export interface MarginResult {
  status:            MarginStatus;
  /** Null when unknown — never 0, which would read as "no margin". */
  marginBps:         Bps | null;
  grossPerSeatMonthPaise: Paise;
  grossMonthlyPaise:      Paise;
  grossAnnualPaise:       Paise;
  /** True when the vendor now costs more than the customer pays. */
  isLoss:            boolean;
}

/**
 * Gross margin, as a fraction of what the CUSTOMER pays.
 *
 *   margin = (sell − cost) ÷ sell
 *
 * On revenue, not on cost. Markup-on-cost gives a bigger, flattering number for
 * the same trade (₹110 → ₹270 is 59% margin but 145% markup), and every downstream
 * report here talks about revenue.
 */
export function computeMargin(input: MarginInput): MarginResult {
  const { sellPerSeatMonthPaise: sell, costPerSeatMonthPaise: cost, seats } = input;
  const thin = input.thinBelowBps ?? THIN_MARGIN_BPS;

  const grossPerSeat = sell - cost;
  const grossMonthly = grossPerSeat * Math.max(0, seats);

  const base: Omit<MarginResult, "status" | "marginBps"> = {
    grossPerSeatMonthPaise: grossPerSeat,
    grossMonthlyPaise:      grossMonthly,
    grossAnnualPaise:       grossMonthly * 12,
    isLoss:                 grossPerSeat < 0,
  };

  // Nothing to divide by — a free or zero-priced line has no margin to report.
  if (sell <= 0) return { ...base, status: "unknown", marginBps: null };

  /* Zero cost: genuine for the reseller's own services, missing data for anything
     resold. See RESOLD_VENDORS above. */
  if (cost === 0 && RESOLD_VENDORS.has((input.vendor ?? "").toLowerCase())) {
    return { ...base, status: "unknown", marginBps: null };
  }

  const marginBps = Math.round(((sell - cost) * 10_000) / sell);

  return {
    ...base,
    marginBps,
    status: marginBps < 0 ? "loss" : marginBps < thin ? "thin" : "healthy",
  };
}

export interface ErosionInput extends MarginInput {
  /** What the vendor charged when this was sold, in paise. Null if not recorded. */
  costAtSalePerSeatMonthPaise?: Paise | null;
}

export interface ErosionResult extends MarginResult {
  /** True when today's cost is higher than the cost at the time of sale. */
  costRose:              boolean;
  costRisePerSeatPaise:  Paise | null;
  /** What the margin WAS, for comparison. Null when the old cost is unknown. */
  marginAtSaleBps:       Bps | null;
  /** Points of margin lost. Null when the old cost is unknown. */
  erodedBps:            Bps | null;
  /** True when this subscription should be repriced before it renews. */
  needsRepricing:        boolean;
}

/**
 * Has a vendor price rise eaten the margin on a subscription already sold?
 *
 * The scenario this exists for: a seat sold at ₹270 when wholesale was ₹110. The
 * vendor raises wholesale to ₹300. The customer is locked into ₹270, so every
 * renewal now LOSES ₹30 a seat a month — and nothing in the app says so, because
 * the subscription looks exactly as healthy as the day it was signed.
 *
 * `needsRepricing` is true on a loss or a thin margin whether or not the old cost
 * was recorded. Erosion is the explanation; the loss is the thing to act on, and
 * demanding a historical cost before flagging a loss-making line would mean the
 * rows with the worst data are the ones that stay silent.
 */
export function detectErosion(input: ErosionInput): ErosionResult {
  const now = computeMargin(input);
  const oldCost = input.costAtSalePerSeatMonthPaise;

  const haveOld = typeof oldCost === "number" && Number.isFinite(oldCost) && oldCost >= 0;
  const costRose = haveOld ? input.costPerSeatMonthPaise > oldCost : false;

  const marginAtSaleBps = haveOld && input.sellPerSeatMonthPaise > 0
    ? Math.round(((input.sellPerSeatMonthPaise - oldCost) * 10_000) / input.sellPerSeatMonthPaise)
    : null;

  return {
    ...now,
    costRose,
    costRisePerSeatPaise: haveOld ? input.costPerSeatMonthPaise - oldCost : null,
    marginAtSaleBps,
    erodedBps: marginAtSaleBps !== null && now.marginBps !== null
      ? marginAtSaleBps - now.marginBps
      : null,
    needsRepricing: now.status === "loss" || now.status === "thin",
  };
}

/** 5930 → "59.3%". Null → "—", because an unknown margin is not zero. */
export function formatBps(bps: Bps | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return "—";
  return `${(bps / 100).toFixed(1)}%`;
}
