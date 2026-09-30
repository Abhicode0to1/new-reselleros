/**
 * An in-memory stand-in for the slice of supabase-js the crons use — FOR TESTS ONLY.
 *
 * It behaves like PostgREST where it matters for scale bugs: every read is cut at
 * `maxRows` (1000, like supabase/config.toml), silently, exactly as the real server does.
 * So a test that seeds 2,500 rows fails if the code under test reads them with one
 * un-paged select — which is the bug these tests pin.
 *
 * Supported: from().select(cols, {count, head}) with eq / neq / in / is / not(col, "is", null)
 * / gt / gte / lt / lte / order / range / limit / maybeSingle / single, plus insert / upsert /
 * update (recorded, and applied to the in-memory table). Column projection is not applied —
 * rows come back whole. Every call is recorded in `calls` for assertions.
 */
type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

export interface FakeCall {
  table: string;
  op: "select" | "insert" | "upsert" | "update" | "delete";
  inLists: Array<{ col: string; size: number }>;
  range: [number, number] | null;
  filters: string[];
  payload?: unknown;
}

export function fakePostgrest(tables: Record<string, Row[]>, opts: { maxRows?: number } = {}) {
  const maxRows = opts.maxRows ?? 1000;
  const calls: FakeCall[] = [];

  function builder(table: string) {
    const call: FakeCall = { table, op: "select", inLists: [], range: null, filters: [] };
    calls.push(call);
    const filters: Filter[] = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let limit: number | null = null;
    let countMode = false;
    let head = false;
    let single: "maybe" | "one" | null = null;
    let payload: Row | Row[] | null = null;

    const rowsOf = () => (tables[table] ??= []);
    const matching = () => rowsOf().filter((r) => filters.every((f) => f(r)));

    const b = {
      select(_cols?: string, o?: { count?: string; head?: boolean }) {
        if (o?.count) countMode = true;
        if (o?.head) head = true;
        return b;
      },
      eq(col: string, v: unknown) { call.filters.push(`${col}=${String(v)}`); filters.push((r) => r[col] === v); return b; },
      neq(col: string, v: unknown) { filters.push((r) => r[col] !== v); return b; },
      in(col: string, vs: readonly unknown[]) {
        call.inLists.push({ col, size: vs.length });
        const set = new Set(vs);
        filters.push((r) => set.has(r[col]));
        return b;
      },
      is(col: string, v: unknown) { filters.push((r) => (r[col] ?? null) === v); return b; },
      not(col: string, op: string, v: unknown) {
        if (op === "is") filters.push((r) => (r[col] ?? null) !== v);
        else if (op === "in") {
          const list = String(v).replace(/^\(|\)$/g, "").split(",");
          filters.push((r) => !list.includes(String(r[col])));
        }
        return b;
      },
      gt(col: string, v: never) { filters.push((r) => (r[col] as never) > v); return b; },
      gte(col: string, v: never) { filters.push((r) => (r[col] as never) >= v); return b; },
      lt(col: string, v: never) { filters.push((r) => (r[col] as never) < v); return b; },
      lte(col: string, v: never) { filters.push((r) => (r[col] as never) <= v); return b; },
      order(col: string, o?: { ascending?: boolean }) { orders.push({ col, asc: o?.ascending ?? true }); return b; },
      range(from: number, to: number) { call.range = [from, to]; return b; },
      limit(n: number) { limit = n; return b; },
      maybeSingle() { single = "maybe"; return b; },
      single() { single = "one"; return b; },
      insert(p: Row | Row[]) { call.op = "insert"; payload = p; call.payload = p; return b; },
      upsert(p: Row | Row[]) { call.op = "upsert"; payload = p; call.payload = p; return b; },
      update(p: Row) { call.op = "update"; payload = p; call.payload = p; return b; },
      delete() { call.op = "delete"; return b; },
      then<T1, T2>(ok?: (v: unknown) => T1, bad?: (e: unknown) => T2) {
        return Promise.resolve(run()).then(ok, bad);
      },
    };

    function run(): { data: unknown; error: unknown; count?: number | null } {
      if (call.op === "insert" || call.op === "upsert") {
        const list = Array.isArray(payload) ? payload : [payload as Row];
        rowsOf().push(...list);
        return { data: null, error: null };
      }
      if (call.op === "update") {
        for (const r of matching()) Object.assign(r, payload);
        return { data: null, error: null };
      }
      if (call.op === "delete") {
        tables[table] = rowsOf().filter((r) => !filters.every((f) => f(r)));
        return { data: null, error: null };
      }
      let rows = matching();
      const count = countMode ? rows.length : null;
      if (head) return { data: null, error: null, count };
      if (orders.length > 0) {
        rows = [...rows].sort((a, z) => {
          for (const o of orders) {
            const x = a[o.col] as never, y = z[o.col] as never;
            if (x === y) continue;
            return (x < y ? -1 : 1) * (o.asc ? 1 : -1);
          }
          return 0;
        });
      }
      if (call.range) rows = rows.slice(call.range[0], call.range[1] + 1);
      if (limit !== null) rows = rows.slice(0, limit);
      rows = rows.slice(0, maxRows);           // PostgREST's silent cap
      if (single) {
        if (rows.length > 1) return { data: null, error: { message: "multiple rows" } };
        if (rows.length === 0) return single === "one" ? { data: null, error: { message: "no rows" } } : { data: null, error: null };
        return { data: rows[0], error: null };
      }
      return { data: rows, error: null, count };
    }

    return b;
  }

  return {
    client: { from: (t: string) => builder(t) },
    calls,
    tables,
  };
}
