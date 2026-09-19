import { describe, it, expect } from "vitest";
import {
  HOSTING_PLAN_LADDER,
  planFromCode,
  upgradeOptions,
  assessPlanChange,
  previewUpgradeCharge,
  type PlanChangeFacts,
} from "./plan-change";
import { LANDING_PLANS } from "@/site/lib/data/hosting-landing";

describe("the ladder", () => {
  it("is the three real plans, smallest first", () => {
    expect(HOSTING_PLAN_LADDER.map((p) => p.code)).toEqual(["starter", "standard", "plus"]);
    expect(HOSTING_PLAN_LADDER.map((p) => p.rank)).toEqual([1, 2, 3]);
  });

  /* One source of price. A second copy of these numbers here would be a second
     price, and the one that drifted would be the one nobody looked at. */
  it("takes its prices from LANDING_PLANS and nowhere else", () => {
    for (const p of HOSTING_PLAN_LADDER) {
      const src = LANDING_PLANS.find((l) => l.planId === p.code);
      expect(src, `no LANDING_PLANS entry for ${p.code}`).toBeDefined();
      expect(p.monthlyRate).toBe(src!.price);
    }
  });

  it("prices increase up the ladder — otherwise 'upgrade' means nothing", () => {
    for (let i = 1; i < HOSTING_PLAN_LADDER.length; i++) {
      expect(HOSTING_PLAN_LADDER[i].monthlyRate).toBeGreaterThan(HOSTING_PLAN_LADDER[i - 1].monthlyRate);
    }
  });

  it("its MB quotas agree with the GB it advertises", () => {
    /* Two representations of one fact, and the pair a customer would notice: the
       page says 25 GB and the account row would say 25600 MB. A mismatch here
       shows up as a plan that claims one size and enforces another. */
    for (const p of HOSTING_PLAN_LADDER) {
      const diskGb = Number(p.storage.replace(/[^0-9.]/g, ""));
      const bwGb = Number(p.bandwidth.replace(/[^0-9.]/g, ""));
      expect(p.diskQuotaMb, `${p.code} disk`).toBe(diskGb * 1024);
      expect(p.bandwidthQuotaMb, `${p.code} bandwidth`).toBe(bwGb * 1024);
    }
  });

  it("disk grows up the ladder — a bigger plan with less room is not an upgrade", () => {
    for (let i = 1; i < HOSTING_PLAN_LADDER.length; i++) {
      expect(HOSTING_PLAN_LADDER[i].diskQuotaMb).toBeGreaterThan(HOSTING_PLAN_LADDER[i - 1].diskQuotaMb);
      expect(HOSTING_PLAN_LADDER[i].bandwidthQuotaMb).toBeGreaterThan(
        HOSTING_PLAN_LADDER[i - 1].bandwidthQuotaMb,
      );
    }
  });

  it("carries a DirectAdmin package name for every plan", () => {
    for (const p of HOSTING_PLAN_LADDER) {
      expect(p.daPackage, `${p.code} has no daPackage`).toBeTruthy();
      /* DA package names: letters, digits, underscore, dash — the same rule
         isPackageName() enforces before a change is sent. A plan whose package
         name would be refused there is a plan nobody can ever be moved onto. */
      expect(p.daPackage).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
  });
});

describe("planFromCode — three shapes have been stored over this project's life", () => {
  it.each([
    ["standard", "standard"],
    ["hosting-standard", "standard"],
    ["Standard", "standard"],
    ["STANDARD", "standard"],
    ["  hosting-Plus  ", "plus"],
    ["starter", "starter"],
  ])("%s resolves to %s", (raw, code) => {
    expect(planFromCode(raw)?.code).toBe(code);
  });

  /* Null is a real answer, and the caller must handle it. Returning the smallest
     plan instead would offer an upgrade to somebody already on the largest — and
     charge them for it. */
  it.each([null, undefined, "", "   ", "hosting-", "enterprise", "Standard Plus", "starter2"])(
    "%p is unknown, not a default",
    (raw) => {
      expect(planFromCode(raw as string | null)).toBeNull();
    },
  );
});

describe("upgradeOptions", () => {
  it("offers only bigger plans", () => {
    expect(upgradeOptions("starter").map((p) => p.code)).toEqual(["standard", "plus"]);
    expect(upgradeOptions("standard").map((p) => p.code)).toEqual(["plus"]);
  });

  it("offers nothing on the top plan", () => {
    expect(upgradeOptions("plus")).toEqual([]);
  });

  /* The important one. An unknown plan must offer NOTHING, not everything. */
  it.each([null, undefined, "", "mystery-plan"])("offers nothing when the current plan is %p", (raw) => {
    expect(upgradeOptions(raw as string | null)).toEqual([]);
  });

  it("accepts the stored `hosting-` prefix", () => {
    expect(upgradeOptions("hosting-standard").map((p) => p.code)).toEqual(["plus"]);
  });
});

const OK: PlanChangeFacts = {
  status: "pending",
  fromPlanCode: "starter",
  requestedPlanCode: "plus",
  livePlanCode: "starter",
  hostingStatus: "active",
  isTrial: false,
};

describe("assessPlanChange — the happy path", () => {
  it("approves a real upgrade on a live account", () => {
    const v = assessPlanChange(OK);
    expect(v.canApprove).toBe(true);
    if (v.canApprove) {
      expect(v.from.code).toBe("starter");
      expect(v.to.code).toBe("plus");
      /* What actually gets sent to the server. */
      expect(v.daPackage).toBe("Plus");
    }
  });

  it("reads the LIVE plan as the from-plan, not the stored one", () => {
    /* Both agree here, so `from` must be the live row either way — this pins
       which one the caller will charge from. */
    const v = assessPlanChange({ ...OK, fromPlanCode: "hosting-starter", livePlanCode: "Starter" });
    expect(v.canApprove).toBe(true);
    if (v.canApprove) expect(v.from.code).toBe("starter");
  });
});

describe("assessPlanChange — every refusal says what to do next (§24)", () => {
  /* Not a style check. A rep looking at a greyed-out Approve with no explanation
     does the change by hand at the server and forgets to close the request —
     which is the drift the live-plan check exists to catch. */
  const refusals: Array<[string, PlanChangeFacts]> = [
    ["already decided", { ...OK, status: "approved" }],
    ["rejected", { ...OK, status: "rejected" }],
    ["withdrawn", { ...OK, status: "withdrawn" }],
    ["unknown requested plan", { ...OK, requestedPlanCode: "enterprise" }],
    ["no requested plan", { ...OK, requestedPlanCode: null }],
    ["unknown live plan", { ...OK, livePlanCode: null }],
    ["account suspended", { ...OK, hostingStatus: "suspended" }],
    ["account pending", { ...OK, hostingStatus: "pending" }],
    ["account expired", { ...OK, hostingStatus: "expired" }],
    ["account terminated", { ...OK, hostingStatus: "terminated" }],
    ["account failed", { ...OK, hostingStatus: "failed" }],
    ["moved underneath", { ...OK, livePlanCode: "standard" }],
    ["already on it", { ...OK, requestedPlanCode: "starter" }],
    ["downgrade", { ...OK, fromPlanCode: "plus", livePlanCode: "plus", requestedPlanCode: "starter" }],
    /* A trial is `active`, so nothing status-shaped would ever reach it. */
    ["a free trial", { ...OK, isTrial: true }],
  ];

  it.each(refusals)("%s is refused with a reason and a next step", (_label, facts) => {
    const v = assessPlanChange(facts);
    expect(v.canApprove).toBe(false);
    if (!v.canApprove) {
      expect(v.reason.length, "reason is empty").toBeGreaterThan(10);
      expect(v.nextStep.length, "nextStep is empty").toBeGreaterThan(10);
      /* A next step that just restates the refusal is not a next step. */
      expect(v.nextStep).not.toBe(v.reason);
    }
  });

  it("names both plans when the account moved underneath the request", () => {
    const v = assessPlanChange({ ...OK, fromPlanCode: "starter", livePlanCode: "standard" });
    expect(v.canApprove).toBe(false);
    if (!v.canApprove) {
      /* The rep has to be able to see WHAT changed without opening two screens. */
      expect(v.reason).toContain("Starter");
      expect(v.reason).toContain("Standard");
    }
  });

  it("explains a downgrade in terms of the disk, not just 'not allowed'", () => {
    const v = assessPlanChange({
      ...OK,
      fromPlanCode: "plus",
      livePlanCode: "plus",
      requestedPlanCode: "starter",
    });
    expect(v.canApprove).toBe(false);
    if (!v.canApprove) {
      expect(v.reason).toMatch(/downgrade/i);
      expect(v.nextStep).toMatch(/quota|disk/i);
    }
  });

  /* Ordering: "it moved" is more useful than "that is a downgrade" when both
     are true, because the rep's next action is to go back to the customer. */
  it("reports the move, not the direction, when the account moved to something bigger", () => {
    const v = assessPlanChange({
      ...OK,
      fromPlanCode: "starter",
      livePlanCode: "plus",
      requestedPlanCode: "standard",
    });
    expect(v.canApprove).toBe(false);
    if (!v.canApprove) expect(v.reason).toMatch(/on Plus now/);
  });

  /* ─── The trial hole, measured 11 Sep 2026 ────────────────────────────────
     The portal hid the chooser on a trial and that was the ONLY thing stopping
     an upgrade. Proven by calling the route directly against a trial whose
     plan_code was real: HTTP 200, request created. A trial has no paid term, so
     the charge falls back to a FULL term and bills the whole annual difference
     between two plans the customer has paid for neither of. */
  it("refuses a trial even though a trial is 'active'", () => {
    const v = assessPlanChange({ ...OK, isTrial: true, hostingStatus: "active" });
    expect(v.canApprove).toBe(false);
    if (!v.canApprove) {
      expect(v.reason).toMatch(/trial/i);
      /* The next step is the real one: convert it, do not upgrade it. */
      expect(v.nextStep).toMatch(/convert/i);
    }
  });

  it("reports the trial BEFORE anything else — it is the more useful sentence", () => {
    /* A suspended trial is both. "This is a trial" tells the rep what to do;
       "it is suspended" sends them to fix the wrong thing. */
    const v = assessPlanChange({ ...OK, isTrial: true, hostingStatus: "suspended" });
    expect(v.canApprove).toBe(false);
    if (!v.canApprove) expect(v.reason).toMatch(/trial/i);
  });

  it("gives each non-active status its own next step", () => {
    const steps = (["suspended", "pending", "expired", "terminated", "failed"] as const).map((s) => {
      const v = assessPlanChange({ ...OK, hostingStatus: s });
      return v.canApprove ? "" : v.nextStep;
    });
    /* All five distinct — a shared "fix the account first" would be useless on
       four of them. */
    expect(new Set(steps).size).toBe(5);
  });
});

describe("previewUpgradeCharge — the DIFFERENCE, prorated", () => {
  const FULL_YEAR = { remainingDays: 365, termDays: 365, taxRatePct: 18 };

  it("charges the monthly difference over a full remaining year", () => {
    const p = previewUpgradeCharge({ fromPlanCode: "starter", toPlanCode: "plus", ...FULL_YEAR });
    expect(p).not.toBeNull();
    /* 187.20 - 49.99 = 137.21/mo → ×12 = 1646.52 → ₹1,647 after one rounding. */
    expect(p!.monthlyDelta).toBe(137);
    expect(p!.subtotal).toBe(1647);
    expect(p!.tax).toBe(296);
    expect(p!.total).toBe(1943);
  });

  /* The whole reason this is a delta. The customer already paid for the term on
     their current plan; charging the full new rate bills them twice for the part
     they own. */
  it("is cheaper than charging the new plan outright", () => {
    const delta = previewUpgradeCharge({ fromPlanCode: "starter", toPlanCode: "plus", ...FULL_YEAR })!;
    const plusFullYear = Math.round(187.2 * 12);
    expect(delta.subtotal).toBeLessThan(plusFullYear);
  });

  it("falls as the term runs down", () => {
    const days = [365, 180, 90, 30, 1];
    const totals = days.map(
      (d) => previewUpgradeCharge({ fromPlanCode: "starter", toPlanCode: "plus", remainingDays: d, termDays: 365, taxRatePct: 18 })!.total,
    );
    for (let i = 1; i < totals.length; i++) {
      expect(totals[i], `${days[i]} days charged more than ${days[i - 1]}`).toBeLessThan(totals[i - 1]);
    }
  });

  it("clamps days beyond the term rather than over-charging", () => {
    const over = previewUpgradeCharge({ fromPlanCode: "starter", toPlanCode: "plus", remainingDays: 900, termDays: 365, taxRatePct: 18 })!;
    expect(over.remainingDays).toBe(365);
    expect(over.subtotal).toBe(1647);
  });

  /* Null, never zero. A UI renders 0 as "₹0" and "this upgrade is free" is not a
     claim this function should be able to make by accident. */
  it.each([
    ["a downgrade", { fromPlanCode: "plus", toPlanCode: "starter" }],
    ["the same plan", { fromPlanCode: "plus", toPlanCode: "plus" }],
    ["an unknown from-plan", { fromPlanCode: "mystery", toPlanCode: "plus" }],
    ["an unknown to-plan", { fromPlanCode: "starter", toPlanCode: "mystery" }],
    ["a null from-plan", { fromPlanCode: null, toPlanCode: "plus" }],
  ])("returns null for %s", (_label, plans) => {
    expect(previewUpgradeCharge({ ...plans, ...FULL_YEAR })).toBeNull();
  });

  it.each([
    ["no term", { remainingDays: 365, termDays: 0 }],
    ["a negative term", { remainingDays: 365, termDays: -30 }],
    ["no days left", { remainingDays: 0, termDays: 365 }],
    ["negative days left", { remainingDays: -5, termDays: 365 }],
  ])("returns null for %s", (_label, days) => {
    expect(
      previewUpgradeCharge({ fromPlanCode: "starter", toPlanCode: "plus", ...days, taxRatePct: 18 }),
    ).toBeNull();
  });

  it("a zero tax rate is priced, not refused — an export is a real case", () => {
    const p = previewUpgradeCharge({ fromPlanCode: "starter", toPlanCode: "standard", remainingDays: 365, termDays: 365, taxRatePct: 0 });
    expect(p).not.toBeNull();
    expect(p!.tax).toBe(0);
    expect(p!.total).toBe(p!.subtotal);
  });

  /* Every rung, both single and double steps, so no pair is priced negatively or
     nonsensically by an ordering mistake in the ladder. */
  it("prices every upgrade pair as a positive amount", () => {
    const pairs: Array<[string, string]> = [
      ["starter", "standard"],
      ["standard", "plus"],
      ["starter", "plus"],
    ];
    for (const [a, b] of pairs) {
      const p = previewUpgradeCharge({ fromPlanCode: a, toPlanCode: b, ...FULL_YEAR });
      expect(p, `${a} → ${b} priced null`).not.toBeNull();
      expect(p!.total, `${a} → ${b}`).toBeGreaterThan(0);
      expect(p!.monthlyDelta, `${a} → ${b}`).toBeGreaterThan(0);
    }
  });

  it("a two-rung upgrade costs more than either single rung", () => {
    const one = previewUpgradeCharge({ fromPlanCode: "starter", toPlanCode: "standard", ...FULL_YEAR })!;
    const two = previewUpgradeCharge({ fromPlanCode: "starter", toPlanCode: "plus", ...FULL_YEAR })!;
    expect(two.total).toBeGreaterThan(one.total);
  });
});
