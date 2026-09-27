/**
 * Depreciation — Income-tax Act WDV, per asset, per financial year.
 *
 * Rules (Rule 5, Appendix I; s.32):
 *   · written-down value method at the block's rate on the opening WDV
 *   · an asset put to use for LESS than 180 days in the FY it was bought earns half the
 *     rate that year (put to use on/after 4 Oct in a normal year)
 *   · nothing in the FY of disposal for that asset (in law the block continues; per-asset
 *     is the practical approximation for a company with a dozen assets — the CA works the
 *     block totals from this schedule)
 *   · whole rupees; the schedule stops when WDV would go below ₹1
 *
 * Rates as they stand for FY 2026-27: computers & software 40%, plant & machinery 15%,
 * furniture 10%, motor vehicles 15%, buildings 10%, intangibles 25%. A change is one row
 * in BLOCKS. Companies-Act SLM (for statutory accounts) is not modelled; the Balance
 * Sheet here is the owner's view and the ITR view, both of which use these.
 */

export type AssetBlock = "computers" | "plant" | "furniture" | "vehicles" | "building" | "intangible";

export const BLOCKS: Record<AssetBlock, { label: string; ratePct: number; examples: string }> = {
  computers:  { label: "Computers & software", ratePct: 40, examples: "laptop, desktop, printer, server, software licence" },
  plant:      { label: "Plant & machinery",    ratePct: 15, examples: "AC, generator, camera, phone, office equipment" },
  furniture:  { label: "Furniture & fittings", ratePct: 10, examples: "desks, chairs, interiors, electrical fittings" },
  vehicles:   { label: "Motor vehicles",       ratePct: 15, examples: "car, bike, scooter" },
  building:   { label: "Building",            ratePct: 10, examples: "office premises (not land)" },
  intangible: { label: "Intangibles",         ratePct: 25, examples: "trademark, purchased software product, goodwill" },
};

export interface AssetLike {
  id: string;
  name: string;
  block: AssetBlock;
  cost: number;
  put_to_use: string;              // YYYY-MM-DD
  disposed_on?: string | null;
  disposal_value?: number | null;
}

export function fyStartOf(iso: string): number {
  const [y, m] = iso.slice(0, 7).split("-").map(Number);
  return m >= 4 ? y : y - 1;
}
export const fyLabel = (fy: number) => `${fy}-${String((fy + 1) % 100).padStart(2, "0")}`;
const fyEnd = (fy: number) => `${fy + 1}-03-31`;

/** Days from put-to-use to the FY end, inclusive of both ends. */
function daysUsedInFirstFy(putToUse: string): number {
  const a = new Date(putToUse + "T00:00:00Z").getTime();
  const b = new Date(fyEnd(fyStartOf(putToUse)) + "T00:00:00Z").getTime();
  return Math.floor((b - a) / 86_400_000) + 1;
}

export interface DepRow { fy: number; fyLabel: string; opening: number; ratePct: number; halfRate: boolean; depreciation: number; closing: number; note?: string }

/** Year-by-year schedule from the year of purchase up to and including `uptoFy`. */
export function depreciationSchedule(a: AssetLike, uptoFy: number): DepRow[] {
  const rows: DepRow[] = [];
  const firstFy = fyStartOf(a.put_to_use);
  const disposalFy = a.disposed_on ? fyStartOf(a.disposed_on) : null;
  const fullRate = BLOCKS[a.block].ratePct;
  let wdv = Math.max(0, Math.round(a.cost));
  for (let fy = firstFy; fy <= uptoFy; fy++) {
    if (disposalFy !== null && fy >= disposalFy) {
      rows.push({ fy, fyLabel: fyLabel(fy), opening: wdv, ratePct: 0, halfRate: false, depreciation: 0, closing: 0,
        note: `Sold / scrapped ${a.disposed_on} for ₹${Math.round(a.disposal_value ?? 0).toLocaleString("en-IN")} — ${wdv - Math.round(a.disposal_value ?? 0) >= 0 ? "short-term loss" : "gain"} ₹${Math.abs(wdv - Math.round(a.disposal_value ?? 0)).toLocaleString("en-IN")} on the block` });
      wdv = 0;
      break;
    }
    const halfRate = fy === firstFy && daysUsedInFirstFy(a.put_to_use) < 180;
    const rate = halfRate ? fullRate / 2 : fullRate;
    const dep = Math.min(wdv, Math.round((wdv * rate) / 100));
    rows.push({ fy, fyLabel: fyLabel(fy), opening: wdv, ratePct: rate, halfRate, depreciation: dep, closing: wdv - dep });
    wdv -= dep;
    if (wdv < 1) break;
  }
  return rows;
}

/** WDV at the END of `fy` (0 before purchase or after disposal). */
export function wdvAtFyEnd(a: AssetLike, fy: number): number {
  if (fy < fyStartOf(a.put_to_use)) return 0;
  const rows = depreciationSchedule(a, fy);
  return rows.length ? rows[rows.length - 1].closing : 0;
}

/** Depreciation charged in `fy` for this asset. */
export function depreciationInFy(a: AssetLike, fy: number): number {
  return depreciationSchedule(a, fy).find((r) => r.fy === fy)?.depreciation ?? 0;
}

/** Book value today: opening WDV of the current FY (last year's closing), or cost if
 *  bought this year — the Balance Sheet figure until the year's depreciation is booked. */
export function bookValueNow(a: AssetLike, today: string): number {
  const fy = fyStartOf(today);
  if (a.put_to_use > today) return 0;
  if (a.disposed_on && a.disposed_on <= today) return 0;
  if (fyStartOf(a.put_to_use) >= fy) return Math.round(a.cost);
  return wdvAtFyEnd(a, fy - 1);
}

export interface RegisterSummary {
  fy: number;
  cost: number;
  openingWdv: number;
  depreciation: number;
  closingWdv: number;
  byBlock: { block: AssetBlock; label: string; ratePct: number; count: number; cost: number; depreciation: number; closingWdv: number }[];
}

export function registerSummary(assets: AssetLike[], fy: number): RegisterSummary {
  const live = assets.filter((a) => fyStartOf(a.put_to_use) <= fy);
  const byBlock = (Object.keys(BLOCKS) as AssetBlock[]).map((block) => {
    const rows = live.filter((a) => a.block === block);
    return {
      block, label: BLOCKS[block].label, ratePct: BLOCKS[block].ratePct, count: rows.length,
      cost: rows.reduce((s, a) => s + Math.round(a.cost), 0),
      depreciation: rows.reduce((s, a) => s + depreciationInFy(a, fy), 0),
      closingWdv: rows.reduce((s, a) => s + wdvAtFyEnd(a, fy), 0),
    };
  }).filter((b) => b.count > 0);
  const cost = byBlock.reduce((s, b) => s + b.cost, 0);
  const depreciation = byBlock.reduce((s, b) => s + b.depreciation, 0);
  const closingWdv = byBlock.reduce((s, b) => s + b.closingWdv, 0);
  const openingWdv = live.reduce((s, a) => s + (fyStartOf(a.put_to_use) === fy ? 0 : wdvAtFyEnd(a, fy - 1)), 0);
  return { fy, cost, openingWdv, depreciation, closingWdv, byBlock };
}
