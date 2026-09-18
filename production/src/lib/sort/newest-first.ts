/**
 * Newest on top — the default order for every list of records in the app.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * Abhishek, 18 Sep 2026: "just make it default that work on all tables — recent entry
 * show on top."
 *
 * The lists were each ordered by whatever seemed natural for that table in isolation:
 * Customers A–Z, Subscriptions by renewal date, Items by vendor then price, Vendors and
 * Parent Accounts A–Z. Every one of those is a defensible order, and together they had
 * the same practical effect — the record you had just created was somewhere in the
 * middle. Create a customer called FF Impex and it lands between Doodh Sang and
 * Globalnow; you then hunt for it to check it saved correctly. That hunt is the entire
 * complaint, and it is a per-table decision that should not have been made per table.
 *
 * ─── WHY THIS IS APPLIED PER PAGE, NOT IN THE QUERIES ───────────────────────
 * The obvious fix is to change `.order(...)` in the query hooks. It is the wrong one:
 * those hooks also feed PICKERS. `useCustomers` fills the customer combobox, `useItems`
 * fills the plan dropdown in the Add Subscription dialog. In a dropdown you are looking
 * for a name you already know, so A–Z is right and "most recently created" is nearly
 * useless. Reordering the query would fix the table and quietly damage the picker.
 *
 * So the pages sort their own rows, and the hooks keep the order that suits everyone
 * else. One function, so "newest first" means the same thing on all of them.
 *
 * ─── WHY A STABLE SORT, AND WHY NULLS SINK ──────────────────────────────────
 * `Array.prototype.sort` is stable in every engine we target, so rows with equal or
 * missing timestamps keep the order the query gave them — an existing sensible order
 * (A–Z, by renewal date) survives underneath rather than being scrambled. Rows with no
 * timestamp go last: a missing `created_at` means "we do not know when", and parking an
 * unknown at the very top is the opposite of what this is for. Old imported rows are
 * exactly the ones most likely to be missing it.
 */

/** Anything with a creation timestamp. Most tables call it `created_at`. */
export interface HasCreatedAt {
  created_at?: string | null;
}

/**
 * A copy of `rows`, most recently created first.
 *
 * Two signatures, so the common call stays short AND stays type-safe. Without the first
 * one, reading `created_at` off an unconstrained T needs a cast — and a cast means a
 * table with no such column compiles perfectly and sorts nothing at all, because every
 * timestamp comes back undefined. A silent no-op is the worst outcome here: the page
 * looks changed, the order does not change, and nobody finds out until somebody wonders
 * why their new record is still in the middle of the list.
 */
export function newestFirst<T extends HasCreatedAt>(rows: readonly T[]): T[];
/**
 * @param pick  Where the timestamp lives, when it is not `created_at` — e.g. an invoice
 *              that records `invoice_date`, or a payment that records `received_at`.
 */
export function newestFirst<T>(
  rows: readonly T[],
  pick: (row: T) => string | null | undefined,
): T[];
export function newestFirst<T>(
  rows: readonly T[],
  pick: (row: T) => string | null | undefined = (r) => (r as HasCreatedAt).created_at,
): T[] {
  return [...rows].sort((a, b) => {
    const ta = stamp(pick(a));
    const tb = stamp(pick(b));
    /* Both unknown → 0, so the stable sort leaves them where they were. One unknown →
       it sinks, whichever side it is on. */
    if (ta === null && tb === null) return 0;
    if (ta === null) return 1;
    if (tb === null) return -1;
    return tb - ta;
  });
}

/**
 * Milliseconds, or null when there is nothing usable.
 *
 * Guards against the string that is present but not a date — `""` from an empty form
 * field, or a malformed import. `new Date("").getTime()` is NaN, and NaN comparisons all
 * return false, which makes a comparator return 0 for every pair and silently disables
 * the sort rather than failing.
 */
function stamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}
