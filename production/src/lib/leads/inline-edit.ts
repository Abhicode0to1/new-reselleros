/**
 * Parsing + validation for the inline-editable cells in the pipeline table.
 *
 * Deal Value is the reason this file is pure and tested: it feeds the "Open
 * Pipeline ₹8.3L" KPI, so a sloppy parse silently changes a number the owner
 * makes decisions on. The rule throughout is **reject, never guess** — an input
 * we don't understand returns an error and the cell keeps its old value, rather
 * than coercing to 0 or NaN and looking like a successful save.
 */

/** Money is whole rupees everywhere in this codebase (see docs/ACCOUNTING-AUDIT). */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const LAKH = 100_000;
const CRORE = 10_000_000;

/**
 * Parse what an Indian reseller actually types into a value cell.
 *
 * Accepts: `50000` · `50,000` · `₹1,50,000` · `1.5L` · `2 Cr` · `` (clears it)
 * Rejects: negatives, non-numeric text, and anything with stray characters.
 *
 * Returns whole rupees. `null` means "cleared", which is different from 0 —
 * an unpriced deal is not a ₹0 deal, and the pipeline total must not treat it
 * as one.
 */
export function parseRupeeInput(raw: string): ParseResult<number | null> {
  const s = raw.trim().replace(/[₹\s,]/g, "");
  if (s === "") return { ok: true, value: null };

  const m = /^(-?\d+(?:\.\d+)?)(l|lakh|lac|cr|crore)?$/i.exec(s);
  if (!m) return { ok: false, error: "Enter a number like 50000, 50,000 or 1.5L" };

  const n = Number(m[1]);
  if (!Number.isFinite(n)) return { ok: false, error: "That isn't a number" };
  if (n < 0) return { ok: false, error: "Value can't be negative" };

  const unit = (m[2] ?? "").toLowerCase();
  const mult = unit.startsWith("l") ? LAKH : unit.startsWith("c") ? CRORE : 1;
  const rupees = Math.round(n * mult);

  // A deal larger than ₹100 Cr is far likelier to be a typo (an extra zero, or
  // paise pasted in) than a real order. Refuse rather than let it distort the
  // pipeline KPI — the operator can still enter it deliberately in the drawer.
  if (rupees > 100 * CRORE) return { ok: false, error: "That looks too large — check the figure" };

  return { ok: true, value: rupees };
}

/** Priorities the leads table accepts (matches the CHECK on leads.priority). */
export const PRIORITIES = ["low", "medium", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];

export function parsePriority(raw: string): ParseResult<Priority> {
  const v = raw.trim().toLowerCase();
  return (PRIORITIES as readonly string[]).includes(v)
    ? { ok: true, value: v as Priority }
    : { ok: false, error: "Pick low, medium or high" };
}

/**
 * Follow-up date. Stored as a plain `YYYY-MM-DD` date (the column is `date`),
 * so no timezone conversion — shifting it into UTC is how a follow-up set for
 * "tomorrow" ends up showing as today for an IST user.
 */
export function parseFollowUpDate(raw: string): ParseResult<string | null> {
  const s = raw.trim();
  if (s === "") return { ok: true, value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: false, error: "Use a date like 2026-08-20" };
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return { ok: false, error: "That date doesn't exist" };
  // Round-trip guards against 2026-02-31, which Date happily rolls forward.
  if (d.toISOString().slice(0, 10) !== s) return { ok: false, error: "That date doesn't exist" };
  return { ok: true, value: s };
}

/**
 * Did the edit actually change anything? Used to skip a pointless write (and a
 * pointless optimistic re-render) when the operator opens a cell and tabs out.
 */
export function isUnchanged(before: unknown, after: unknown): boolean {
  if (before === after) return true;
  // null and "" both mean "empty" coming out of an input.
  const norm = (v: unknown) => (v === "" || v === undefined ? null : v);
  return norm(before) === norm(after);
}
