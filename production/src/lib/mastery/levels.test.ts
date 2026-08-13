import { describe, it, expect } from "vitest";
import {
  xpForLevel, levelForXp, tierForLevel, progressForXp, allocatePool,
  TIERS, MAX_LEVEL, type AllocationInput,
} from "./levels";

describe("the XP curve", () => {
  it("starts everyone at level 1 with zero XP", () => {
    expect(xpForLevel(1)).toBe(0);
    expect(levelForXp(0)).toBe(1);
  });

  it("rises strictly, so more XP can never mean a lower level", () => {
    for (let l = 2; l <= MAX_LEVEL; l++) {
      expect(xpForLevel(l), `L${l}`).toBeGreaterThan(xpForLevel(l - 1));
    }
  });

  it("round-trips for every level — the threshold lands you on that level", () => {
    // The strong check: the formula and its inverse must agree at all 50 bands,
    // because a level decides a tier, and a tier decides a share of real money.
    for (let l = 1; l <= MAX_LEVEL; l++) {
      expect(levelForXp(xpForLevel(l)), `at threshold of L${l}`).toBe(l);
      if (l < MAX_LEVEL) {
        expect(levelForXp(xpForLevel(l + 1) - 1), `one XP short of L${l + 1}`).toBe(l);
      }
    }
  });

  it("clamps a real but huge total at the top level", () => {
    expect(levelForXp(9_999_999)).toBe(MAX_LEVEL);
    expect(xpForLevel(0)).toBe(0);
    expect(xpForLevel(999)).toBe(xpForLevel(MAX_LEVEL));
  });

  it("sends CORRUPT XP to level 1, never to level 50", () => {
    // A level decides a tier, and Master tier carries a 1.3× multiplier on a
    // cash bonus. So bad data must fail DOWNWARD. Reading NaN or Infinity as
    // level 50 would promote someone to the top pay band on a parse error;
    // reading it as level 1 costs them nothing they earned, because real XP
    // still computes normally.
    expect(levelForXp(NaN)).toBe(1);
    expect(levelForXp(Infinity)).toBe(1);
    expect(levelForXp(-Infinity)).toBe(1);
    expect(levelForXp(-500)).toBe(1);
  });
});

describe("tier bands", () => {
  it("covers 1…50 with no gap and no overlap", () => {
    for (let l = 1; l <= MAX_LEVEL; l++) {
      const matches = TIERS.filter((t) => l >= t.minLevel && l <= t.maxLevel);
      expect(matches, `level ${l}`).toHaveLength(1);
    }
  });

  it("puts the boundaries exactly where the brief says", () => {
    expect(tierForLevel(1).name).toBe("Apprentice");
    expect(tierForLevel(10).name).toBe("Apprentice");
    expect(tierForLevel(11).name).toBe("Specialist");
    expect(tierForLevel(25).name).toBe("Specialist");
    expect(tierForLevel(26).name).toBe("Expert");
    expect(tierForLevel(40).name).toBe("Expert");
    expect(tierForLevel(41).name).toBe("Master");
    expect(tierForLevel(50).name).toBe("Master");
  });

  it("carries the agreed multipliers", () => {
    expect(tierForLevel(5).multiplier).toBe(1.0);
    expect(tierForLevel(15).multiplier).toBe(1.1);
    expect(tierForLevel(30).multiplier).toBe(1.2);
    expect(tierForLevel(45).multiplier).toBe(1.3);
  });
});

describe("progressForXp — what the bar renders", () => {
  it("is a real fraction, never NaN, at every level threshold", () => {
    for (let l = 1; l <= MAX_LEVEL; l++) {
      const p = progressForXp(xpForLevel(l));
      expect(Number.isFinite(p.fraction), `L${l}`).toBe(true);
      expect(p.fraction).toBeGreaterThanOrEqual(0);
      expect(p.fraction).toBeLessThanOrEqual(1);
    }
  });

  it("sits at the start of a level on its exact threshold", () => {
    const p = progressForXp(xpForLevel(11));
    expect(p.level).toBe(11);
    expect(p.fraction).toBe(0);
    expect(p.tier.name).toBe("Specialist");
  });

  it("reports how much is left to the next level", () => {
    const p = progressForXp(xpForLevel(5) + 10);
    expect(p.level).toBe(5);
    expect(p.xpToNext).toBe(xpForLevel(6) - xpForLevel(5) - 10);
  });

  it("shows a full bar and no next target at max level", () => {
    const p = progressForXp(xpForLevel(MAX_LEVEL) + 5000);
    expect(p.level).toBe(MAX_LEVEL);
    expect(p.fraction).toBe(1);
    expect(p.nextLevelAt).toBeNull();
    expect(p.xpToNext).toBeNull();
  });

  it("handles zero and garbage XP", () => {
    for (const xp of [0, -1, NaN]) {
      const p = progressForXp(xp);
      expect(p.level).toBe(1);
      expect(Number.isFinite(p.fraction)).toBe(true);
    }
  });
});

describe("allocatePool — the money guarantee", () => {
  const rows: AllocationInput[] = [
    { userId: "a", score: 300, xp: 0      },   // Apprentice 1.0×
    { userId: "b", score: 300, xp: 6_000  },   // Specialist 1.1×
    { userId: "c", score: 300, xp: 40_000 },   // Expert     1.2×
    { userId: "d", score: 300, xp: 90_000 },   // Master     1.3×
  ];

  it("pays out EXACTLY the pool, never a rupee more or less", () => {
    // The guarantee that makes a payroll run balance. Rounding each share
    // independently drifts; largest remainder does not.
    for (const pool of [1, 7, 100, 999, 50_000, 123_457]) {
      const out = allocatePool(rows, pool);
      const sum = out.reduce((s, o) => s + o.rupees, 0);
      expect(sum, `pool ${pool}`).toBe(pool);
    }
  });

  it("sums exactly with awkward scores and an odd pool", () => {
    const odd: AllocationInput[] = [
      { userId: "p", score: 7,  xp: 0 },
      { userId: "q", score: 11, xp: 6_000 },
      { userId: "r", score: 13, xp: 90_000 },
    ];
    const out = allocatePool(odd, 1_001);
    expect(out.reduce((s, o) => s + o.rupees, 0)).toBe(1_001);
  });

  it("never pays a negative amount", () => {
    const out = allocatePool(
      [{ userId: "a", score: -500, xp: 0 }, { userId: "b", score: 100, xp: 0 }],
      10_000
    );
    for (const o of out) expect(o.rupees).toBeGreaterThanOrEqual(0);
    expect(out.reduce((s, o) => s + o.rupees, 0)).toBe(10_000);
  });

  it("gives a higher tier a bigger share for identical work — and it is zero-sum", () => {
    const out = allocatePool(rows, 46_000);
    const by = Object.fromEntries(out.map((o) => [o.userId, o.rupees]));
    expect(by.d).toBeGreaterThan(by.c);
    expect(by.c).toBeGreaterThan(by.b);
    expect(by.b).toBeGreaterThan(by.a);
    // The pool did not grow to fund the Master's extra — it came from the others.
    expect(out.reduce((s, o) => s + o.rupees, 0)).toBe(46_000);
  });

  it("pays zero to everyone when the pool is zero, without NaN", () => {
    const out = allocatePool(rows, 0);
    for (const o of out) expect(o.rupees).toBe(0);
  });

  it("pays zero when nobody scored, rather than dividing by zero", () => {
    const out = allocatePool(
      [{ userId: "a", score: 0, xp: 0 }, { userId: "b", score: 0, xp: 90_000 }],
      50_000
    );
    for (const o of out) {
      expect(o.rupees).toBe(0);
      expect(Number.isFinite(o.rupees)).toBe(true);
    }
  });

  it("treats a negative pool as no pool", () => {
    const out = allocatePool(rows, -50_000);
    expect(out.reduce((s, o) => s + o.rupees, 0)).toBe(0);
  });

  it("gives the same rupees whatever order the rows arrive in", () => {
    // A bonus that moves by ₹1 between two refreshes reads as a bug even when
    // the total is right, so the tie-break must be deterministic.
    const forward  = allocatePool(rows, 10_000);
    const reversed = allocatePool([...rows].reverse(), 10_000);
    const f = Object.fromEntries(forward.map((o) => [o.userId, o.rupees]));
    const r = Object.fromEntries(reversed.map((o) => [o.userId, o.rupees]));
    expect(f).toEqual(r);
  });

  it("reports the level and tier it used, so a payslip can be explained", () => {
    const out = allocatePool(rows, 10_000);
    const d = out.find((o) => o.userId === "d")!;
    expect(d.tier).toBe("Master");
    expect(d.multiplier).toBe(1.3);
    expect(d.weight).toBeCloseTo(d.score * 1.3);
  });

  it("handles a single person and an empty team", () => {
    expect(allocatePool([{ userId: "solo", score: 5, xp: 0 }], 777)[0].rupees).toBe(777);
    expect(allocatePool([], 777)).toEqual([]);
  });
});
