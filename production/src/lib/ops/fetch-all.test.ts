import { describe, it, expect, vi } from "vitest";
import { fetchAllRows, fetchAllRowsIn, PAGE_SIZE, IN_CHUNK } from "./fetch-all";

/** A fake table behind a PostgREST-like cap: `.range(from, to)` returns at most `cap` rows. */
function table<T>(rows: T[], cap = PAGE_SIZE) {
  return vi.fn(async (from: number, to: number) => ({
    data: rows.slice(from, Math.min(to + 1, from + cap)),
    error: null,
  }));
}

describe("fetchAllRows", () => {
  it("reads past the 1000-row cap — 2,500 rows in three pages", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => i);
    const page = table(rows);
    const out = await fetchAllRows(page);
    expect(out).toEqual(rows);
    expect(page.mock.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("an exact multiple of the page size costs one extra (empty) page, not a lost page", async () => {
    const page = table(Array.from({ length: 2000 }, (_, i) => i));
    expect(await fetchAllRows(page)).toHaveLength(2000);
    expect(page).toHaveBeenCalledTimes(3);
  });

  it("no rows → one request, empty list", async () => {
    const page = table([]);
    expect(await fetchAllRows(page)).toEqual([]);
    expect(page).toHaveBeenCalledTimes(1);
  });

  it("null data is an empty page", async () => {
    expect(await fetchAllRows(async () => ({ data: null, error: null }))).toEqual([]);
  });

  it("throws the query's error instead of treating a failed page as the last one", async () => {
    const err = { message: "boom", code: "57014" };
    let n = 0;
    const page = async () => (n++ === 0 ? { data: Array(PAGE_SIZE).fill(1), error: null } : { data: null, error: err });
    await expect(fetchAllRows(page)).rejects.toBe(err);
  });

  it("maxRows stops early and never returns more", async () => {
    const page = table(Array.from({ length: 5000 }, (_, i) => i));
    const out = await fetchAllRows(page, { maxRows: 1500 });
    expect(out).toHaveLength(1500);
    expect(page).toHaveBeenCalledTimes(2);
  });

  it("refuses a nonsense page size", async () => {
    await expect(fetchAllRows(table([]), { pageSize: 0 })).rejects.toThrow(RangeError);
  });
});

describe("fetchAllRowsIn", () => {
  it("chunks the id list at 200 and de-duplicates it", async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id${i}`);
    const seen: string[][] = [];
    const out = await fetchAllRowsIn([...ids, "id0", null, undefined], async (run) => {
      seen.push(run);
      return { data: run.map((id) => ({ id })), error: null };
    });
    expect(seen.map((s) => s.length)).toEqual([IN_CHUNK, IN_CHUNK, 50]);
    expect(out.map((r) => r.id)).toEqual(ids);
  });

  it("pages INSIDE a chunk when one chunk matches more than the cap", async () => {
    const calls: Array<[number, number, number]> = [];
    const out = await fetchAllRowsIn(["a", "b"], async (run, from, to) => {
      calls.push([run.length, from, to]);
      const all = run.flatMap((id) => Array.from({ length: 700 }, (_, i) => `${id}${i}`));
      return { data: all.slice(from, to + 1), error: null };
    });
    expect(out).toHaveLength(1400);
    expect(calls).toEqual([[2, 0, 999], [2, 1000, 1999]]);
  });

  it("an empty id list makes no request", async () => {
    const page = vi.fn();
    expect(await fetchAllRowsIn([], page)).toEqual([]);
    expect(page).not.toHaveBeenCalled();
  });
});
