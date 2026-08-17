/**
 * The three support plans — one definition, read by the catalogue, the quote builder
 * and the SLA router.
 *
 * ─── WHY THE ANNUAL PRICE IS A TOTAL AND NOT A MONTHLY RATE ─────────────────
 * The rest of the catalogue prices per seat per MONTH and derives the year as
 * `monthly × 12` (lib/subscriptions/catalog-options.ts). That works for Workspace and
 * M365, where the annual commitment is simply a different monthly rate.
 *
 * A discounted year is not a different monthly rate — it is its own number, and
 * deriving it from one loses the discount. So `annualTotal` is stored as the
 * whole-rupee TOTAL it actually is, and nothing re-derives it. A test asserts it is
 * NOT monthly × 12, so the discount cannot be quietly deleted.
 *
 * ─── AND WHY THE YEARLY PRICES DIVIDE BY TWELVE ─────────────────────────────
 * ₹9,996, not ₹9,990. The difference is six rupees and it removes a whole class of
 * bug: record_payment derives a subscription's mrr as round(line_amount / 12)
 * (baseline.sql:4580), so the term a subscription believes in is always twelve whole
 * monthly rupees.
 *
 *   ₹9,990 ÷ 12 = ₹832.50 → mrr ₹833 → the subscription reads ₹9,996 against a quote
 *   of ₹9,990. Six rupees, and two numbers for one plan on two different screens.
 *
 *   ₹9,996 ÷ 12 = ₹833 exactly → the subscription reads ₹9,996. Same number
 *   everywhere.
 *
 * The saving is unchanged at 17% and two months free, because the badge is computed
 * from the prices rather than written down. Pardeep chose the six rupees over the
 * discrepancy on 17 Aug 2026.
 *
 * ─── AND WHY THE SAVING IS COMPUTED, NOT WRITTEN DOWN ───────────────────────
 * The brief asks for a "Save 17% · 2 Months Free!" badge. Both figures are derived
 * from the two prices below. A hardcoded 17% becomes a lie the first time somebody
 * changes a price, and it is the kind of lie that prints on a quote.
 */

export type SupportTierId = "free" | "standard" | "enterprise";

/** How a customer can reach support on a given tier. */
export interface SupportChannels {
  email:    boolean;
  /** WhatsApp, and when. `null` = not included on this tier. */
  whatsapp: "business_hours" | "24x7" | null;
  /** Live Meet calls included per month. `null` = unlimited, 0 = not included. */
  meetCallsPerMonth: number | null;
}

export interface SupportTier {
  id:    SupportTierId;
  label: string;
  icon:  string;
  /** ₹ per month, whole rupees. Zero is a real price on the free tier. */
  monthly: number;
  /** ₹ for a whole year, whole rupees. NOT monthly × 12 — see the header. */
  annualTotal: number;
  /** Hours to first response. What the SLA timer counts down. */
  slaHours: number;
  /** The banner colour a ticket gets in the queue. */
  alert: "danger" | "warning" | "info";
  channels: SupportChannels;
  /** Named account contact. */
  accountManager: boolean;
  /** One line for the plan card. */
  summary: string;
}

export const SUPPORT_TIERS: readonly SupportTier[] = [
  {
    id: "free", label: "Free", icon: "🆓",
    monthly: 0, annualTotal: 0,
    slaHours: 24,
    alert: "info",
    channels: { email: true, whatsapp: null, meetCallsPerMonth: 0 },
    accountManager: false,
    summary: "Email helpdesk, answered within a working day.",
  },
  {
    id: "standard", label: "Standard", icon: "🥈",
    /* ₹833 × 12 exactly — see the header on why the year divides by twelve. */
    monthly: 999, annualTotal: 9_996,
    slaHours: 4,
    alert: "warning",
    channels: { email: true, whatsapp: "business_hours", meetCallsPerMonth: 2 },
    accountManager: false,
    summary: "Priority email in 4 hours, WhatsApp in business hours, 2 live calls a month.",
  },
  {
    id: "enterprise", label: "Enterprise", icon: "🥇",
    /* ₹4,166 × 12 exactly. */
    monthly: 4_999, annualTotal: 49_992,
    slaHours: 1,
    alert: "danger",
    channels: { email: true, whatsapp: "24x7", meetCallsPerMonth: null },
    accountManager: true,
    summary: "One-hour response, WhatsApp around the clock, unlimited live calls, named account manager.",
  },
] as const;

export function supportTier(id: SupportTierId): SupportTier {
  const t = SUPPORT_TIERS.find((x) => x.id === id);
  /* Not a fallback to `free`. A caller asking for a tier that does not exist has a
     bug, and silently downgrading them would hide it behind a worse SLA. */
  if (!t) throw new Error(`Unknown support tier: ${id}`);
  return t;
}

/** Catalogue SKU id for a tier and cycle — stable, so re-seeding updates in place. */
export function supportSkuId(id: SupportTierId, cycle: "monthly" | "yearly"): string {
  return `SUP-${id.toUpperCase()}-${cycle === "yearly" ? "YR" : "MO"}`;
}

/**
 * Find a tenant's catalogue row for a tier and cycle.
 *
 * The seeded ids carry the tenant on the end (`SUP-STANDARD-YR-fbb976f1…`) so two
 * tenants' rows never collide, which means the lookup is a prefix match rather than
 * an equality one. Returns null when the SKU has not been seeded for this tenant —
 * the caller shows that as "not in your catalogue", never as a ₹0 plan.
 */
export function findSupportSku<T extends { id: string }>(
  items: readonly T[],
  tier: SupportTierId,
  cycle: "monthly" | "yearly",
): T | null {
  const prefix = supportSkuId(tier, cycle);
  return items.find((i) => i.id === prefix || i.id.startsWith(`${prefix}-`)) ?? null;
}

/* ── The saving, derived ───────────────────────────────────────────────────── */

export interface AnnualSaving {
  /** ₹ saved over a year by paying yearly. Zero on a free plan. */
  rupees: number;
  /** Whole percent, rounded. */
  percent: number;
  /**
   * Months of the monthly price the saving covers, to one decimal.
   * Null when there is nothing to compare (a free plan divides by zero).
   */
  monthsFree: number | null;
}

/**
 * What paying yearly actually saves.
 *
 * Returns null when there is no saving at all, so a badge is shown only when there is
 * something to show — a "Save 0%" badge is noise that teaches reps to ignore badges.
 */
export function annualSaving(tier: SupportTier): AnnualSaving | null {
  const twelveMonths = tier.monthly * 12;
  const rupees = twelveMonths - tier.annualTotal;
  if (tier.monthly <= 0 || rupees <= 0) return null;
  return {
    rupees,
    percent: Math.round((rupees / twelveMonths) * 100),
    monthsFree: Math.round((rupees / tier.monthly) * 10) / 10,
  };
}

/** ₹ charged for one term on a given cycle. The only place this choice is made. */
export function supportPrice(tier: SupportTier, cycle: "monthly" | "yearly"): number {
  return cycle === "yearly" ? tier.annualTotal : tier.monthly;
}

/* ── SLA ───────────────────────────────────────────────────────────────────── */

/**
 * When a ticket raised now is due a first response.
 *
 * ─── ELAPSED HOURS, NOT WORKING HOURS ───────────────────────────────────────
 * A one-hour Enterprise SLA is one hour on the clock — that is what "24/7" on the
 * tier means. Standard's four hours are counted the same way here, deliberately:
 * a business-hours calendar needs holidays, a working week and a timezone per
 * customer, and inventing one would produce a due time nobody can predict. Until
 * that exists, the timer is honest about being wall-clock.
 */
export function slaDueAt(raisedAtISO: string, tier: SupportTier): string {
  const raised = new Date(raisedAtISO).getTime();
  return new Date(raised + tier.slaHours * 3_600_000).toISOString();
}

export interface SlaState {
  dueAtISO: string;
  /** Negative once the deadline has passed. */
  minutesRemaining: number;
  breached: boolean;
  /** Within the last quarter of the window. */
  atRisk: boolean;
}

export function slaState(dueAtISO: string, nowISO: string, tier: SupportTier): SlaState {
  const remainingMs = new Date(dueAtISO).getTime() - new Date(nowISO).getTime();
  const minutesRemaining = Math.round(remainingMs / 60_000);
  const windowMs = tier.slaHours * 3_600_000;
  return {
    dueAtISO,
    minutesRemaining,
    breached: remainingMs < 0,
    /* Last quarter of the window. Proportional rather than a fixed number of
       minutes, because "30 minutes left" is comfortable on a 24-hour SLA and
       already lost on a one-hour one. */
    atRisk: remainingMs >= 0 && remainingMs <= windowMs * 0.25,
  };
}

/* ── Which tier is a customer on ───────────────────────────────────────────── */

/**
 * Resolve a tier from the plan name on an active subscription.
 *
 * Falls back to `free` ONLY when nothing matches, because a customer with no support
 * subscription genuinely is on the free tier — that is the plan, not a guess. The
 * match is on the SKU id when available and the plan name otherwise, since a
 * subscription stores the plan as text.
 */
export function tierFromPlanName(plan: string | null | undefined): SupportTierId {
  const p = (plan ?? "").toLowerCase();
  if (!p) return "free";
  if (p.includes("enterprise")) return "enterprise";
  if (p.includes("standard"))   return "standard";
  return "free";
}

/** Can this tier ask for a live call right now? */
export function canRequestLiveCall(tier: SupportTier): boolean {
  return tier.channels.meetCallsPerMonth === null || tier.channels.meetCallsPerMonth > 0;
}

/**
 * Is a live call still within this month's allowance?
 *
 * `null` allowance is unlimited. The count is passed in rather than fetched so this
 * stays pure and the caller decides what "this month" means in IST.
 */
export function liveCallAllowance(tier: SupportTier, usedThisMonth: number): {
  allowed: boolean;
  remaining: number | null;
  reason: string | null;
} {
  const cap = tier.channels.meetCallsPerMonth;
  if (cap === null) return { allowed: true, remaining: null, reason: null };
  if (cap === 0) {
    return {
      allowed: false, remaining: 0,
      reason: `Live calls are not part of the ${tier.label} plan. Standard includes 2 a month.`,
    };
  }
  const remaining = Math.max(0, cap - usedThisMonth);
  return remaining > 0
    ? { allowed: true, remaining, reason: null }
    : {
        allowed: false, remaining: 0,
        reason: `All ${cap} live calls on the ${tier.label} plan have been used this month. They reset on the 1st.`,
      };
}
