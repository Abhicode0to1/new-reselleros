/**
 * The volume rate card — how much discount a seat count earns, and where the AI must stop.
 *
 * Pure, and the single source for it. The quote path applies it, the sales agent's prompt is
 * rendered from it, and the money guard's allow-list is built from it, so the price the agent
 * SAYS and the price the quote CHARGES cannot come from two different tables. That is not a
 * style preference: on 24 Aug 2026 `verifyDraftMoney` approved a below-cost figure precisely
 * because its allow-list was built from the same wrong source as the draft, and the fix was to
 * make one computation feed both.
 *
 * ─── THE SLABS ARE PERCENTAGES, NOT RUPEES, AND THAT IS DELIBERATE ──────────
 * The rate card was handed over as rupees: "21–50 seats: 3% Instant Discount (₹262/seat)".
 * Those rupee figures are ₹/seat/MONTH and they are Starter's. Two things go wrong if they
 * are stored as written:
 *
 *   1. THE UNIT. A quote line carries ₹/seat/YEAR (msrp × 12) — ₹3,240 for Starter, not ₹270.
 *      Writing ₹262 onto an annual line is a 12× error, which is the exact defect found live
 *      on 24 Aug and written up as AGENTS.md L106 that same week.
 *   2. THE PRODUCT. ₹262 is 3% off Starter. It is not 3% off Standard (₹864), M365 (₹990) or
 *      Zoho (₹120). One rupee figure can only ever be right for one SKU.
 *
 * A percentage is right in every unit and on every product. The rupee examples survive here
 * as comments, where they document intent without being able to price anything.
 *
 * ─── ROUNDING IS DOWN, IN THE CUSTOMER'S FAVOUR ─────────────────────────────
 * 3% off ₹270 is ₹261.90 and 5% is ₹256.50, and this schema stores whole rupees. Rounding
 * DOWN was chosen (Pardeep, 25 Aug) so the discount actually delivered is never less than the
 * one advertised — "you said 5% and gave me 4.8%" is an argument worth a rupee a seat to
 * avoid. On 100 seats over a year the choice is worth about ₹1,200, so it is written down
 * rather than left to whichever rounding a future caller reaches for.
 */

/** Percentage off list, by seat count. */
export interface VolumeSlab {
  /** Inclusive lower bound. */
  minSeats: number;
  /** Inclusive upper bound. `null` means "no upper bound within the automatic range". */
  maxSeats: number | null;
  /** Whole percent off the list rate. 0 for the full-price slab. */
  percent: number;
  /** What the customer is told this is. Rendered into the agent's prompt. */
  label: string;
}

/**
 * The rate card. Order matters — `slabFor` returns the first match.
 *
 * Rupee figures in the comments are Starter (₹270/seat/month) and are illustrations only;
 * nothing reads them.
 */
export const VOLUME_SLABS: readonly VolumeSlab[] = [
  { minSeats: 1,  maxSeats: 20,  percent: 0, label: "List price" },                     // ₹270
  { minSeats: 21, maxSeats: 50,  percent: 3, label: "3% volume discount" },             // ₹261
  { minSeats: 51, maxSeats: 100, percent: 5, label: "5% reseller volume discount" },    // ₹256
];

/**
 * Above this, the AI does not price at all — a person does.
 *
 * 100, raised from the previous flat 50. The rate card stops here because past it the answer
 * is genuinely "it depends": a 300-seat deal is negotiated against what the vendor will fund,
 * and no table can hold that.
 */
export const CUSTOM_PRICING_ABOVE = 100;

/**
 * Above this, the quote is BUILT but never sent unattended.
 *
 * The band between this and CUSTOM_PRICING_ABOVE is the one that changed behaviour: 51–100
 * seats used to reach a human with no quote attached, and now reaches them with the whole 5%
 * quote already priced and drafted.
 *
 * It is not auto-sent, and that is the third time this codebase has taken this shape —
 * `reply.send`, `support.reply.send` and `telecall.place` all ship built-but-held. Each of
 * those caught real defects on first live contact. A 51–100 seat Standard deal is roughly
 * ₹8 lakh a year and would be the largest thing this app has ever done unattended, on a
 * discount policy that has not yet been exercised once. Moving the line later is a dial, not
 * a code change.
 */
export const REVIEW_ABOVE_SEATS = 50;

export type SlabOutcome =
  | { kind: "slab"; slab: VolumeSlab }
  /** Above the rate card — hand to a person, do not price. */
  | { kind: "custom"; reason: string }
  /** Not a seat count anybody orders. */
  | { kind: "invalid"; reason: string };

/** Which slab applies to this seat count. */
export function slabFor(seats: number): SlabOutcome {
  if (!Number.isInteger(seats) || seats <= 0) {
    return { kind: "invalid", reason: `${seats} is not a seat count` };
  }

  const slab = VOLUME_SLABS.find(
    (s) => seats >= s.minSeats && (s.maxSeats === null || seats <= s.maxSeats),
  );
  if (slab) return { kind: "slab", slab };

  return {
    kind: "custom",
    reason:
      `${seats} seats is above the ${CUSTOM_PRICING_ABOVE}-seat rate card — pricing this size ` +
      "is negotiated against what the vendor will fund, so it is a person's call, not a table's",
  };
}

/** True when this seat count may be quoted AND sent without anybody reading it first. */
export function maySendUnattended(seats: number): boolean {
  return seats > 0 && seats <= REVIEW_ABOVE_SEATS;
}

export interface DiscountedRate {
  /** ₹ per seat, in whatever unit `listRate` was — whole rupees, rounded DOWN. */
  rate: number;
  /** The percent actually applied. 0 when the floor blocked the discount. */
  appliedPercent: number;
  /** Set when the discount was reduced or refused, in words for the operator. */
  note: string | null;
}

/**
 * Apply a slab to one line's list rate, and refuse to go below what we pay the vendor.
 *
 * ─── THE FLOOR IS PER PRODUCT, NEVER A CONSTANT ─────────────────────────────
 * The rate card came with "Hard Rule: vendor wholesale cost (₹110) — below this is physically
 * impossible for the AI". ₹110 is STARTER's wholesale. Standard's is ₹620 and AppSheet Core's
 * is ₹720. A single ₹110 floor would happily approve selling Standard at ₹256 — ₹364 per seat
 * per month below cost — while reporting that the hard rule had been honoured. So the floor is
 * this line's own `cost`, passed in from `items.wholesale`.
 *
 * Measured 25 Aug 2026: at 5%, no product in this catalogue goes below its cost — the thinnest
 * margin is AppSheet Core at 13.3%. So the floor does not bite today. It is here for the day
 * somebody adds a thin-margin SKU or a deeper slab, which is the only day it would matter and
 * the day nobody would think to check.
 *
 * When the floor WOULD be breached the discount is not silently trimmed to fit: it drops to
 * zero and says so. A discount of "4.1%, because that is all the margin allowed" is a number
 * nobody agreed to, arrived at by a machine, in a customer's quote.
 */
export function discountedRate(
  listRate: number,
  percent: number,
  cost: number,
): DiscountedRate {
  if (percent <= 0) return { rate: listRate, appliedPercent: 0, note: null };

  /* Down, not nearest — see the header. `Math.floor` on a positive rate is the customer's
     favour in every case. */
  const discounted = Math.floor(listRate * (1 - percent / 100));

  /* A cost of 0 means "not recorded", not "free" — the same call `isBelowCost` makes in
     sales-agent.ts. A missing cost must not remove a real product from the rate card.
     ─── AND THE COMPARISON IS <=, NOT < ──────────────────────────────────────
     Landing EXACTLY on cost is refused too, for two reasons that arrived together.
     The commercial one: a discount that consumes the entire margin is not an outcome anybody
     designed — the rate card was meant to win volume, not to give the product away.
     The sharper one: at exactly cost, the discounted figure IS our wholesale price, and it
     would then enter the money guard's allow-list. sales-agent.test.ts has a test whose whole
     point is that our buying price must never be quotable — "not a rounding error, it is
     handing the margin to the buyer". A `<` here would open that door for any SKU whose
     margin happens to equal a slab (msrp 100 / cost 95 at 5% is the shape), and it would open
     it silently, on the one product where it matters. */
  if (cost > 0 && discounted <= cost) {
    return {
      rate: listRate,
      appliedPercent: 0,
      note:
        `The ${percent}% volume discount was NOT applied — it would price this line at ` +
        `₹${discounted} against a vendor cost of ₹${cost}, leaving no margin. Quoted at list ` +
        "instead; if this deal needs a discount, it needs a person and a vendor conversation.",
    };
  }

  return { rate: discounted, appliedPercent: percent, note: null };
}

/**
 * The rate card as the agent is allowed to describe it, in plain sentences.
 *
 * Rendered into the prompt rather than written there, so the model can never be shown a slab
 * the code does not apply. The same rule the telecaller's price block follows.
 */
export function slabLines(): string[] {
  const lines = VOLUME_SLABS.map((s) => {
    const range = s.maxSeats === null ? `${s.minSeats}+ seats` : `${s.minSeats}–${s.maxSeats} seats`;
    return s.percent === 0
      ? `- ${range}: list price, no discount`
      : `- ${range}: ${s.percent}% off list (${s.label})`;
  });
  lines.push(
    `- more than ${CUSTOM_PRICING_ABOVE} seats: you may NOT quote. Say that a colleague will ` +
    "price it, and stop.",
  );
  return lines;
}

/**
 * Every per-seat rate the agent may say for one product, given its list rate and cost.
 *
 * Feeds the money guard's allow-list. Built from the same `discountedRate` the quote uses, so
 * a figure the agent quotes correctly can never be flagged as unauthorised, and a figure the
 * quote would never produce can never be authorised.
 */
export function authorisedRatesForItem(listRate: number, cost: number): number[] {
  const rates = new Set<number>([Math.round(listRate)]);
  for (const s of VOLUME_SLABS) {
    if (s.percent <= 0) continue;
    rates.add(discountedRate(listRate, s.percent, cost).rate);
  }
  return [...rates];
}
