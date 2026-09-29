import { describe, it, expect } from "vitest";
import { pLimit, mapLimit, chunk, uniq } from "./p-limit";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("pLimit", () => {
  it("never runs more than `limit` at once, and runs them all", async () => {
    const run = pLimit(3);
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        run(async () => {
          active++;
          peak = Math.max(peak, active);
          await tick(5 + (i % 3) * 3);
          active--;
          done.push(i);
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(done).toHaveLength(12);
  });

  it("actually runs in parallel up to the limit (not serial)", async () => {
    const run = pLimit(4);
    let peak = 0;
    let active = 0;
    await Promise.all(Array.from({ length: 4 }, () => run(async () => {
      active++; peak = Math.max(peak, active); await tick(10); active--;
    })));
    expect(peak).toBe(4);
  });

  it("a rejecting or synchronously throwing task frees its slot", async () => {
    const run = pLimit(1);
    await expect(run(async () => { throw new Error("a"); })).rejects.toThrow("a");
    await expect(run(() => { throw new Error("b"); })).rejects.toThrow("b");
    await expect(run(async () => 42)).resolves.toBe(42);
  });

  it("refuses a nonsense limit", () => {
    expect(() => pLimit(0)).toThrow(RangeError);
    expect(() => pLimit(1.5)).toThrow(RangeError);
  });
});

describe("chunk / uniq", () => {
  it("chunks into bounded runs and keeps every item", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 200)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });
  it("uniq keeps first-seen order", () => {
    expect(uniq(["t2", "t1", "t2", "t3", "t1"])).toEqual(["t2", "t1", "t3"]);
  });
});

describe("mapLimit", () => {
  it("returns results in input order whatever order they finish in", async () => {
    const out = await mapLimit([30, 5, 15, 1], 2, async (ms, i) => { await tick(ms); return `${i}:${ms}`; });
    expect(out).toEqual(["0:30", "1:5", "2:15", "3:1"]);
  });

  it("one failure does not stop the rest; it rejects after all settle", async () => {
    const seen: number[] = [];
    await expect(
      mapLimit([1, 2, 3, 4], 2, async (n) => {
        await tick(2);
        seen.push(n);
        if (n === 2) throw new Error("row 2");
        return n;
      }),
    ).rejects.toThrow("row 2");
    expect(seen.sort()).toEqual([1, 2, 3, 4]);
  });

  it("empty input is an empty result", async () => {
    expect(await mapLimit([], 5, async () => 1)).toEqual([]);
  });
});
