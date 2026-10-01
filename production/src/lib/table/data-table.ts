/**
 * The logic behind <DataTable> (components/ui/data-table.tsx), kept out of React so it
 * can be tested: column sorting, select-all, and saved views (R-085, 1 Oct 2026).
 *
 * Before this, 86 pages each built their own table; none could be sorted by clicking a
 * header and none could remember a filter. A saved view is the page's own filter state
 * (tab, date range, search…) plus the sort, under a name, in this browser's storage.
 */

export type SortDir = "asc" | "desc";
export interface SortState { id: string; dir: SortDir }

export type SortValue = string | number | null | undefined;

/**
 * Stable sort by one column. Empty values (null, undefined, "") go last in both
 * directions — an invoice with no due date should not lead the "earliest due" list.
 */
export function sortRows<T>(rows: readonly T[], sortValue: ((row: T) => SortValue) | undefined, dir: SortDir): T[] {
  if (!sortValue) return [...rows];
  const indexed = rows.map((row, i) => ({ row, i, v: sortValue(row) }));
  const empty = (v: SortValue) => v === null || v === undefined || v === "";
  indexed.sort((a, b) => {
    const ae = empty(a.v), be = empty(b.v);
    if (ae || be) return ae && be ? a.i - b.i : ae ? 1 : -1;
    let c: number;
    if (typeof a.v === "number" && typeof b.v === "number") c = a.v - b.v;
    else c = String(a.v).localeCompare(String(b.v), "en-IN", { numeric: true, sensitivity: "base" });
    if (c === 0) return a.i - b.i;
    return dir === "asc" ? c : -c;
  });
  return indexed.map((x) => x.row);
}

/** Header click: unsorted → asc → desc → unsorted (back to the page's own order). */
export function nextSort(current: SortState | null, id: string): SortState | null {
  if (!current || current.id !== id) return { id, dir: "asc" };
  if (current.dir === "asc") return { id, dir: "desc" };
  return null;
}

/** Select-all toggles between "every visible row" and nothing. */
export function toggleAllIds(selected: ReadonlySet<string>, visibleIds: readonly string[]): Set<string> {
  const allOn = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  return allOn ? new Set() : new Set(visibleIds);
}

export function toggleId(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

// ── Saved views ──────────────────────────────────────────────────────────────

export interface SavedView {
  name: string;
  /** The page's filter state, as the page handed it over. */
  state: Record<string, unknown>;
  sort: SortState | null;
}

/** Minimal storage surface so tests can pass a fake and private windows can fail. */
export interface ViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const viewsKey = (storageKey: string) => `dt.views.${storageKey}`;
export const MAX_VIEWS = 12;

export function loadViews(storage: ViewStorage | null, storageKey: string): SavedView[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(viewsKey(storageKey));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is SavedView =>
        !!v && typeof v === "object" && typeof (v as SavedView).name === "string" &&
        !!(v as SavedView).state && typeof (v as SavedView).state === "object",
    ).map((v) => ({ name: v.name, state: v.state, sort: isSort(v.sort) ? v.sort : null }));
  } catch {
    return [];
  }
}

function isSort(s: unknown): s is SortState {
  return !!s && typeof s === "object" && typeof (s as SortState).id === "string" &&
    ((s as SortState).dir === "asc" || (s as SortState).dir === "desc");
}

/**
 * Adds or replaces (same name, case-insensitive) a view. Newest first, capped at
 * MAX_VIEWS. Returns the list actually stored — on a storage failure, the old one.
 */
export function saveView(storage: ViewStorage | null, storageKey: string, view: SavedView): SavedView[] {
  const name = view.name.trim();
  const current = loadViews(storage, storageKey);
  if (!name) return current;
  const next = [{ ...view, name }, ...current.filter((v) => v.name.toLowerCase() !== name.toLowerCase())].slice(0, MAX_VIEWS);
  return write(storage, storageKey, next) ? next : current;
}

export function deleteView(storage: ViewStorage | null, storageKey: string, name: string): SavedView[] {
  const current = loadViews(storage, storageKey);
  const next = current.filter((v) => v.name !== name);
  return write(storage, storageKey, next) ? next : current;
}

function write(storage: ViewStorage | null, storageKey: string, views: SavedView[]): boolean {
  if (!storage) return false;
  try {
    storage.setItem(viewsKey(storageKey), JSON.stringify(views));
    return true;
  } catch {
    return false;
  }
}

/** True when the page is showing exactly this view (so the menu can tick it). */
export function isViewActive(view: SavedView, state: Record<string, unknown>, sort: SortState | null): boolean {
  return stableJson(view.state) === stableJson(state) &&
    (view.sort?.id ?? null) === (sort?.id ?? null) && (view.sort?.dir ?? null) === (sort?.dir ?? null);
}

function stableJson(o: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
}
