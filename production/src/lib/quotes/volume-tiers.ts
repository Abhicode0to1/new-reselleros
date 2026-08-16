/**
 * Seat-slab volume pricing — "1-10 seats ₹270, 11-50 ₹250, 51+ ₹230".
 *
 * ─── VOLUME, NOT GRADUATED. THIS IS THE WHOLE MONEY DECISION. ───────────────
 * Two billing models wear the same words, and picking the wrong one silently
 * mis-prices every quote:
 *
 *   VOLUME (this file)  — 60 seats × ₹230 = ₹13,800. ONE rate applies to ALL seats,
 *                         chosen by the total seat count.
 *   GRADUATED (not this) — 10×₹270 + 40×₹250 + 10×₹230 = ₹14,950. Each band prices
 *                         only the seats that fall inside it.
 *
 * ₹1,150 apart on one line, and neither number looks wrong on its own.
 *
 * Volume is implemented because it is what this business actually does. Google CSP
 * and Microsoft NCE quote a flat per-seat price, and an Indian reseller offering
 * "50+ seats? ₹230 each" means all fifty at ₹230, not a blend. It is also the only
 * model a QuoteLineItem can represent honestly: a line has ONE `rate` field, so a
 * graduated price would have to be stored as a blended average — a number that
 * appears nowhere in the price list and that nobody can reconcile.
 *
 * If graduated is ever needed it must be a new, named mode with its own tests, not a
 * quiet change to `resolveSlab`. `pricesAllSeatsAtOneRate` exists to fail loudly if
 * someone tries.
 *
 * ─── UNITS ──────────────────────────────────────────────────────────────────
 * Slab prices are ₹ per seat per MONTH, matching `items.prices` (see
 * add-line-item-dialog.tsx, which multiplies by 12 to reach the ₹/seat/YEAR that
 * QuoteLineItem.rate stores). Whole rupees — see AGENTS.md §1.
 */
import type { Item } from "@/lib/supabase/database.types";

export interface SeatSlab {
  /** First seat count this slab covers (inclusive). */
  minSeats: number;
  /** Last seat count this slab covers (inclusive). `null` = open-ended ("51+"). */
  maxSeats: number | null;
  /** ₹/seat/month the customer pays in this slab. */
  msrp: number;
  /** ₹/seat/month the vendor charges us in this slab — the real slab cost matrix. */
  wholesale: number;
}

export interface SlabPricing {
  /** ₹/seat/month the customer pays. */
  msrpPerSeatMonth: number;
  /** ₹/seat/month we pay the vendor. */
  wholesalePerSeatMonth: number;
  /** Which slab was applied, or null when flat pricing was used. */
  slab: SeatSlab | null;
  /** "slab" = a volume band matched · "flat" = the item's normal price */
  source: "slab" | "flat";
  /** Human-readable band, e.g. "11–50 seats". Null when flat. */
  label: string | null;
}

/**
 * Problems that make a slab table unusable. Returned rather than thrown: a broken
 * table in one catalog row must not take down the whole quote builder, and the rep
 * needs to be told which row to fix.
 */
export function validateSlabs(slabs: readonly SeatSlab[]): string[] {
  const errors: string[] = [];
  if (slabs.length === 0) return errors;

  const sorted = [...slabs].sort((a, b) => a.minSeats - b.minSeats);

  if (sorted[0].minSeats !== 1) {
    errors.push(`The first band starts at ${sorted[0].minSeats} seats — it must start at 1, or small orders have no price.`);
  }

  for (const s of sorted) {
    if (s.minSeats < 1) errors.push(`A band starts at ${s.minSeats} seats. Bands start at 1.`);
    if (s.maxSeats !== null && s.maxSeats < s.minSeats) {
      errors.push(`Band ${s.minSeats}–${s.maxSeats} ends before it begins.`);
    }
    if (s.msrp < 0 || s.wholesale < 0) {
      errors.push(`Band starting at ${s.minSeats} seats has a negative price.`);
    }
    /* Below-cost is a business decision, not a data error — a reseller may loss-lead a
       big band deliberately. It is surfaced, never blocked. */
  }

  // Gaps and overlaps. An order landing in a gap would silently fall back to flat
  // pricing at the full rate — the customer is quoted MORE than the price list says.
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i], next = sorted[i + 1];
    if (cur.maxSeats === null) {
      errors.push(`The band starting at ${cur.minSeats} seats is open-ended but is not the last one.`);
      continue;
    }
    if (next.minSeats > cur.maxSeats + 1) {
      errors.push(`Nothing covers ${cur.maxSeats + 1}–${next.minSeats - 1} seats.`);
    } else if (next.minSeats <= cur.maxSeats) {
      errors.push(`Bands ${cur.minSeats}–${cur.maxSeats} and ${next.minSeats}–${next.maxSeats ?? "∞"} overlap.`);
    }
  }

  return errors;
}

/** The slab covering `seats`, or null when none does. */
export function resolveSlab(slabs: readonly SeatSlab[], seats: number): SeatSlab | null {
  if (!Number.isFinite(seats) || seats < 1) return null;
  return slabs.find((s) => seats >= s.minSeats && (s.maxSeats === null || seats <= s.maxSeats)) ?? null;
}

/** "11–50 seats" / "51+ seats" */
export function slabLabel(s: SeatSlab): string {
  return s.maxSeats === null ? `${s.minSeats}+ seats` : `${s.minSeats}–${s.maxSeats} seats`;
}

/** The item's flat (non-slab) ₹/seat/month, preferring the annual commitment tier. */
function flatPerSeatMonth(item: Pick<Item, "msrp" | "wholesale" | "prices">): { msrp: number; wholesale: number } {
  const tier = item.prices?.annual ?? item.prices?.monthly;
  if (tier && tier.msrp > 0) return { msrp: tier.msrp, wholesale: tier.wholesale };
  return { msrp: item.msrp, wholesale: item.wholesale };
}

/**
 * Price `seats` of `item`.
 *
 * Falls back to flat pricing when the item has no slabs, when the slab table is
 * broken, or when no band covers this seat count. Falling back is safe in the one
 * direction that matters: flat is the item's normal price, so a customer is never
 * charged less than the catalogue says because of a data error.
 */
export function slabPricing(
  item: Pick<Item, "msrp" | "wholesale" | "prices">,
  seats: number,
): SlabPricing {
  const flat = flatPerSeatMonth(item);
  const slabs = item.prices?.slabs;

  if (!slabs || slabs.length === 0 || validateSlabs(slabs).length > 0) {
    return { msrpPerSeatMonth: flat.msrp, wholesalePerSeatMonth: flat.wholesale, slab: null, source: "flat", label: null };
  }

  const slab = resolveSlab(slabs, seats);
  if (!slab) {
    return { msrpPerSeatMonth: flat.msrp, wholesalePerSeatMonth: flat.wholesale, slab: null, source: "flat", label: null };
  }

  return {
    msrpPerSeatMonth: slab.msrp,
    wholesalePerSeatMonth: slab.wholesale,
    slab,
    source: "slab",
    label: slabLabel(slab),
  };
}

/**
 * The line totals for `seats` at slab pricing, in ₹/YEAR — the unit QuoteLineItem
 * stores. One multiplication by 12, applied to the per-seat price before the seat
 * count, so the yearly per-seat rate shown on the line is exactly the one that was
 * multiplied out. Rounding once, at the per-seat boundary, is what keeps the line
 * total equal to rate × qty on screen.
 */
export function slabLineTotals(pricing: SlabPricing, seats: number): {
  ratePerSeatYear: number;
  costPerSeatYear: number;
  lineRevenue: number;
  lineCost: number;
  grossMargin: number;
  /** Basis points, so 19.10% is 1910 and never a drifting float. */
  grossMarginBps: number | null;
} {
  const ratePerSeatYear = Math.round(pricing.msrpPerSeatMonth * 12);
  const costPerSeatYear = Math.round(pricing.wholesalePerSeatMonth * 12);
  const qty = Math.max(0, Math.trunc(seats));
  const lineRevenue = ratePerSeatYear * qty;
  const lineCost    = costPerSeatYear * qty;
  return {
    ratePerSeatYear,
    costPerSeatYear,
    lineRevenue,
    lineCost,
    grossMargin: lineRevenue - lineCost,
    /* Null, not zero, when there is no revenue: 0% margin on a ₹0 line is a
       statement about nothing, and it renders identically to a genuine 0% deal. */
    grossMarginBps: lineRevenue > 0 ? Math.round(((lineRevenue - lineCost) / lineRevenue) * 10_000) : null,
  };
}

/**
 * The guard named in this file's header. Volume pricing means every seat bills at the
 * SAME rate; if this ever returns false, someone has introduced graduated pricing
 * without saying so.
 */
export function pricesAllSeatsAtOneRate(pricing: SlabPricing, seats: number): boolean {
  const t = slabLineTotals(pricing, seats);
  return t.lineRevenue === t.ratePerSeatYear * Math.max(0, Math.trunc(seats));
}

/**
 * The next band up, and what the customer would save by reaching it — the upsell line
 * a rep actually uses ("add 4 more seats and every seat drops to ₹250").
 *
 * Returns null when there is no better band, so the UI shows nothing rather than an
 * empty nudge. Only bands that are genuinely CHEAPER per seat qualify: a price list
 * where a bigger band costs more is a data error, not an upsell.
 */
export function nextSlabUpsell(slabs: readonly SeatSlab[], seats: number): {
  seatsToAdd: number;
  newRatePerSeatMonth: number;
  /** ₹/year the customer saves at the new seat count vs staying put and buying them at the old rate. */
  annualSaving: number;
  label: string;
} | null {
  const current = resolveSlab(slabs, seats);
  if (!current) return null;

  const better = [...slabs]
    .filter((s) => s.minSeats > seats && s.msrp < current.msrp)
    .sort((a, b) => a.minSeats - b.minSeats)[0];
  if (!better) return null;

  const seatsToAdd = better.minSeats - seats;
  const atNewBand = better.msrp * 12 * better.minSeats;
  const atOldBand = current.msrp * 12 * better.minSeats;
  return {
    seatsToAdd,
    newRatePerSeatMonth: better.msrp,
    annualSaving: Math.round(atOldBand - atNewBand),
    label: slabLabel(better),
  };
}
