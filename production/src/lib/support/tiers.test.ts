import { describe, it, expect } from "vitest";
import {
  SUPPORT_TIERS, supportTier, supportSkuId, findSupportSku, annualSaving, supportPrice,
  slaDueAt, slaState, tierFromPlanName, canRequestLiveCall, liveCallAllowance,
  type SupportTierId,
} from "./tiers";

describe("the prices are whole rupees, and the year is a TOTAL", () => {
  it("stores every price as a whole rupee", () => {
    /* AGENTS.md §1. Anything with a fractional rupee in it has already gone wrong. */
    for (const t of SUPPORT_TIERS) {
      expect(Number.isInteger(t.monthly)).toBe(true);
      expect(Number.isInteger(t.annualTotal)).toBe(true);
    }
  });

  it("the annual price is NOT twelve monthlies — that is the discount", () => {
    /* If these ever became equal, the yearly discount has been quietly deleted. */
    const std = supportTier("standard");
    expect(std.annualTotal).toBe(9_996);
    expect(std.annualTotal).not.toBe(std.monthly * 12);
  });

  it("every yearly price divides into whole monthly rupees", () => {
    /* This is why the year is ₹9,996 and not ₹9,990.

       record_payment derives a subscription's mrr as round(line_amount / 12)
       (baseline.sql:4580), so the term a subscription believes in is ALWAYS twelve
       whole monthly rupees. A yearly price that does not divide comes back changed:

         ₹9,990 ÷ 12 = ₹832.50 → mrr ₹833 → the subscription reads ₹9,996 against a
         quote of ₹9,990. Six rupees, and two numbers for one plan on two screens.

       Six rupees on the price removes the whole class of bug instead of documenting
       it. Keep this test and the prices stay reconcilable. */
    for (const id of ["standard", "enterprise"] as SupportTierId[]) {
      const t = supportTier(id);
      expect(Number.isInteger(t.annualTotal / 12)).toBe(true);
      // What the subscription will actually believe the term is.
      expect(Math.round(t.annualTotal / 12) * 12).toBe(t.annualTotal);
    }
  });

  it("charges the right figure for each cycle", () => {
    const std = supportTier("standard");
    expect(supportPrice(std, "monthly")).toBe(999);
    expect(supportPrice(std, "yearly")).toBe(9_996);
  });

  it("free is genuinely ₹0, not a missing price", () => {
    const free = supportTier("free");
    expect(free.monthly).toBe(0);
    expect(free.annualTotal).toBe(0);
  });
});

describe("annualSaving — computed, never written down", () => {
  it("matches the badge the brief asked for, from the prices alone", () => {
    /* "Save 17% · 2 Months Free". Derived — a hardcoded 17% becomes a lie the first
       time a price changes, and it is the kind of lie that prints on a quote. */
    const s = annualSaving(supportTier("standard"))!;
    expect(s.rupees).toBe(1_992);        // 11,988 − 9,996
    expect(s.percent).toBe(17);
    expect(s.monthsFree).toBe(2);
  });

  it("gives Enterprise the same deal", () => {
    const s = annualSaving(supportTier("enterprise"))!;
    expect(s.rupees).toBe(9_996);        // 59,988 − 49,992
    expect(s.percent).toBe(17);
    expect(s.monthsFree).toBe(2);
  });

  it("the badge survived rounding the prices to divide by twelve", () => {
    /* The whole reason the saving is computed rather than written down: moving
       Standard from ₹9,990 to ₹9,996 changed the rupees saved and did NOT change
       what the customer is told. A hardcoded "17%" would have needed hand-editing,
       and the day someone forgot is the day a quote lies. */
    for (const id of ["standard", "enterprise"] as SupportTierId[]) {
      const s = annualSaving(supportTier(id))!;
      expect(s.percent).toBe(17);
      expect(s.monthsFree).toBe(2);
    }
  });

  it("shows no badge on a free plan rather than 'Save 0%'", () => {
    /* A zero badge is noise, and noise teaches reps to stop reading badges. */
    expect(annualSaving(supportTier("free"))).toBeNull();
  });

  it("shows no badge when yearly is not actually cheaper", () => {
    const noDiscount = { ...supportTier("standard"), annualTotal: 999 * 12 };
    expect(annualSaving(noDiscount)).toBeNull();
  });
});

describe("SKU ids", () => {
  it("are stable, so re-seeding updates in place instead of duplicating", () => {
    expect(supportSkuId("standard", "monthly")).toBe("SUP-STANDARD-MO");
    expect(supportSkuId("standard", "yearly")).toBe("SUP-STANDARD-YR");
  });

  it("never collide across tiers or cycles", () => {
    const ids = SUPPORT_TIERS.flatMap((t) => [supportSkuId(t.id, "monthly"), supportSkuId(t.id, "yearly")]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("findSupportSku", () => {
  const catalogue = [
    { id: "SUP-STANDARD-MO-fbb976f1", name: "Support Standard (Monthly)" },
    { id: "SUP-STANDARD-YR-fbb976f1", name: "Support Standard (Yearly)" },
    { id: "GW-STR-fbb976f1",          name: "Google Workspace Business Starter" },
  ];

  it("matches the tenant-suffixed id", () => {
    expect(findSupportSku(catalogue, "standard", "yearly")!.id).toBe("SUP-STANDARD-YR-fbb976f1");
    expect(findSupportSku(catalogue, "standard", "monthly")!.id).toBe("SUP-STANDARD-MO-fbb976f1");
  });

  it("does not confuse monthly with yearly", () => {
    /* The prefixes differ only in the last two characters before the tenant id. A
       sloppy `includes` would return whichever came first and quote the wrong price. */
    expect(findSupportSku(catalogue, "standard", "yearly")!.id).not.toContain("-MO-");
  });

  it("returns null when the tier is not in this tenant's catalogue", () => {
    /* The caller says "not in your catalogue" — never falls back to a ₹0 plan. */
    expect(findSupportSku(catalogue, "enterprise", "monthly")).toBeNull();
  });
});

describe("supportTier", () => {
  it("throws on an unknown id instead of quietly downgrading to free", () => {
    /* Falling back would hide a bug behind a worse SLA — the customer would be
       answered in 24 hours on a plan they pay ₹4,999 a month for. */
    // @ts-expect-error deliberately invalid at the type level too
    expect(() => supportTier("platinum")).toThrow(/Unknown support tier/);
  });
});

describe("SLA", () => {
  const RAISED = "2026-08-17T09:00:00.000Z";

  it("counts the hours the tier promises", () => {
    expect(slaDueAt(RAISED, supportTier("enterprise"))).toBe("2026-08-17T10:00:00.000Z");
    expect(slaDueAt(RAISED, supportTier("standard"))).toBe("2026-08-17T13:00:00.000Z");
    expect(slaDueAt(RAISED, supportTier("free"))).toBe("2026-08-18T09:00:00.000Z");
  });

  it("gets stricter as the plan gets dearer", () => {
    const hours = SUPPORT_TIERS.map((t) => t.slaHours);
    expect(hours).toEqual([...hours].sort((a, b) => b - a));
  });

  it("knows when a ticket has breached", () => {
    const due = slaDueAt(RAISED, supportTier("enterprise"));
    expect(slaState(due, "2026-08-17T09:30:00.000Z", supportTier("enterprise")).breached).toBe(false);
    expect(slaState(due, "2026-08-17T10:30:00.000Z", supportTier("enterprise")).breached).toBe(true);
  });

  it("warns proportionally, which no fixed number of minutes can do", () => {
    /* The pair below is the argument. A fixed "warn at 30 minutes" rule would get
       BOTH of these wrong in opposite directions. */
    const ent  = supportTier("enterprise");
    const free = supportTier("free");

    // 5 hours left of a 24-hour window — a fifth remaining, and worth chasing.
    expect(slaState(slaDueAt(RAISED, free), "2026-08-18T04:00:00.000Z", free).atRisk).toBe(true);

    // 30 minutes left of a 60-minute window — half remaining, not a warning yet.
    expect(slaState(slaDueAt(RAISED, ent), "2026-08-17T09:30:00.000Z", ent).atRisk).toBe(false);

    // …and 10 minutes left of that same hour is.
    expect(slaState(slaDueAt(RAISED, ent), "2026-08-17T09:50:00.000Z", ent).atRisk).toBe(true);
  });

  it("a breached ticket is not also 'at risk' — it is past that", () => {
    const ent = supportTier("enterprise");
    const s = slaState(slaDueAt(RAISED, ent), "2026-08-17T11:00:00.000Z", ent);
    expect(s.breached).toBe(true);
    expect(s.atRisk).toBe(false);
    expect(s.minutesRemaining).toBeLessThan(0);
  });
});

describe("tierFromPlanName", () => {
  it("reads the tier off a subscription's plan text", () => {
    expect(tierFromPlanName("Support Enterprise (Yearly)")).toBe("enterprise");
    expect(tierFromPlanName("Support Standard")).toBe("standard");
  });

  it("treats a customer with no support plan as genuinely free", () => {
    /* Not a guess — no support subscription IS the free tier. */
    expect(tierFromPlanName(null)).toBe("free");
    expect(tierFromPlanName("")).toBe("free");
    expect(tierFromPlanName("Google Workspace Business Starter")).toBe("free");
  });
});

describe("live calls", () => {
  it("are not offered on the free plan", () => {
    expect(canRequestLiveCall(supportTier("free"))).toBe(false);
    const a = liveCallAllowance(supportTier("free"), 0);
    expect(a.allowed).toBe(false);
    expect(a.reason).toMatch(/not part of the Free plan/);
  });

  it("counts down Standard's two a month", () => {
    const std = supportTier("standard");
    expect(liveCallAllowance(std, 0).remaining).toBe(2);
    expect(liveCallAllowance(std, 1).remaining).toBe(1);
    const spent = liveCallAllowance(std, 2);
    expect(spent.allowed).toBe(false);
    expect(spent.reason).toMatch(/reset on the 1st/);
  });

  it("does not go negative when more were somehow used than allowed", () => {
    expect(liveCallAllowance(supportTier("standard"), 5).remaining).toBe(0);
  });

  it("never limits Enterprise", () => {
    const a = liveCallAllowance(supportTier("enterprise"), 500);
    expect(a.allowed).toBe(true);
    expect(a.remaining).toBeNull();
  });

  it("every refusal says what to do about it", () => {
    for (const [id, used] of [["free", 0], ["standard", 2]] as [SupportTierId, number][]) {
      const a = liveCallAllowance(supportTier(id), used);
      expect(a.allowed).toBe(false);
      expect(a.reason!.length).toBeGreaterThan(25);
    }
  });
});
