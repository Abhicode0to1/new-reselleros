/**
 * R-118 — a tile's link must land on a list that shows the same records.
 *
 * Three ways that silently breaks, each pinned here:
 *   1. a DRILL entry names a tab the target page does not accept → the page falls back to
 *      "All" and the owner sees more rows than the tile counted;
 *   2. a page stops reading its tab from the URL (someone swaps useUrlChoice back to useState);
 *   3. the lead smart views drift from LEAD_VIEWS.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DRILL, PAGE_CHOICES, LEAD_VIEWS, drillHref, type DrillName } from "./drilldown";
import { pickChoice, withChoice } from "@/lib/hooks/use-url-choice";
import { summarizeDealStrip, wonDate, type DealRow } from "@/lib/deals/pipeline-summary";
import { wonThisMonth } from "@/lib/leads/list-selectors";

const SRC = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("every drill-down targets a tab its page accepts", () => {
  for (const [name, d] of Object.entries(DRILL)) {
    it(name, () => {
      const allowed = PAGE_CHOICES[d.path]?.[d.key];
      expect(allowed, `${d.path} does not read ?${d.key}=`).toBeDefined();
      expect(allowed).toContain(d.value);
    });
  }

  it("drillHref builds the link", () => {
    expect(drillHref("dealsWonMonth")).toBe("/deals?view=won-mtd");
    expect(drillHref("invoicesOverdue")).toBe("/invoices?tab=overdue");
  });
});

describe("list pages read their tab from the URL", () => {
  const PAGES: Array<[string, string, string]> = [
    ["app/(app)/leads/page.tsx", "view", "LEAD_VIEWS"],
    ["app/(app)/quotes/page.tsx", "tab", "QUOTE_TABS"],
    ["app/(app)/invoices/page.tsx", "tab", "INVOICE_TABS"],
    ["app/(app)/subscriptions/page.tsx", "tab", "SUBSCRIPTION_TABS"],
    ["app/(app)/tasks/page.tsx", "tab", "TASK_TABS"],
    ["app/(app)/renewals/page.tsx", "bucket", "RENEWAL_BUCKETS"],
    ["app/(app)/customers/page.tsx", "view", "CUSTOMER_VIEWS"],
    ["app/(app)/payments/page.tsx", "tab", "PAYMENT_TABS"],
  ];
  for (const [file, key, list] of PAGES) {
    it(file, () => {
      expect(read(file)).toMatch(new RegExp(`useUrlChoice<[^>]+>\\("${key}", ${list},`));
    });
  }

  it("LEAD_VIEWS is exactly the SmartView union", () => {
    const tsx = read("components/features/leads/leads-smart-views.tsx");
    const union = [...(tsx.match(/export type SmartView = ([^;]+);/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([...LEAD_VIEWS].sort()).toEqual(union.sort());
  });

  it("each page's tab ids match its TabBar ids", () => {
    const ids = (file: string) => [...read(file).matchAll(/\{ id: "([a-z-]+)",\s+label:/g)].map((m) => m[1]);
    for (const t of ["all", "draft", "sent", "viewed", "accepted", "awaiting", "invoiced", "expired"]) {
      expect(ids("app/(app)/quotes/page.tsx")).toContain(t);
    }
    for (const t of ["all", "paid", "partial", "pending", "overdue", "draft", "void"]) {
      expect(ids("app/(app)/invoices/page.tsx")).toContain(t);
    }
  });
});

describe("pickChoice / withChoice", () => {
  const TABS = ["all", "overdue"] as const;
  it("takes an allowed value, falls back on anything else", () => {
    expect(pickChoice("overdue", TABS, "all")).toBe("overdue");
    expect(pickChoice("bogus", TABS, "all")).toBe("all");
    expect(pickChoice(null, TABS, "all")).toBe("all");
  });
  it("writes the key, drops it for the default, keeps other params", () => {
    expect(withChoice("?lead=L1", "tab", "overdue", "all")).toBe("?lead=L1&tab=overdue");
    expect(withChoice("?lead=L1&tab=overdue", "tab", "all", "all")).toBe("?lead=L1");
    expect(withChoice("", "tab", "all", "all")).toBe("");
  });
});

describe("deal strip counts what /deals shows", () => {
  const NOW = new Date("2026-10-15T06:30:00Z"); // 15 Oct, noon IST
  let n = 0;
  const deal = (p: Partial<DealRow>): DealRow => ({
    id: `d${++n}`, company: `Co ${n}`, stage: "quote", value: 100, expected_close_date: null,
    stage_changed_at: null, created_at: "2026-10-02T05:00:00Z", owner_id: null, lost_at: null, ...p,
  });

  it("closing this month includes open deals whose close date already passed (the list's rule)", () => {
    const s = summarizeDealStrip([
      deal({ expected_close_date: "2026-09-20" }), // past, still open → counted, as the list does
      deal({ expected_close_date: "2026-10-31" }),
      deal({ expected_close_date: "2026-11-01" }), // next month → not
      deal({ expected_close_date: null }),          // undated → not
    ], NOW);
    expect(s.closingThisMonth.count).toBe(2);
  });

  it("won this month falls back to created_at exactly like the won-mtd view", () => {
    const noStamp = { stage: "won" as const, stage_changed_at: null, created_at: "2026-10-03T05:00:00Z" };
    expect(wonDate(noStamp)).toBe("2026-10-03");
    expect(wonThisMonth(noStamp, NOW)).toBe(true);
    const s = summarizeDealStrip([deal(noStamp)], NOW);
    expect(s.wonThisMonth.count).toBe(1);
  });
});

/* Every name in DRILL is used somewhere — a dead entry is a link nobody can click. */
describe("no dead drill-downs", () => {
  it("each DRILL name appears in a component or page", () => {
    const files = [
      "app/(app)/dashboard/page.tsx",
      "components/features/deals/deals-strip.tsx",
      "components/features/dashboard/company-section.tsx",
    ].map(read).join("\n");
    for (const name of Object.keys(DRILL) as DrillName[]) {
      expect(files, name).toContain(`drillHref("${name}")`);
    }
  });
});

describe("won this month is not cut away by the open-only All folder", () => {
  it("folderForView moves won-mtd under All into the Won folder, leaves the rest alone", async () => {
    const { folderForView } = await import("@/lib/leads/list-selectors");
    expect(folderForView("all", "won-mtd")).toBe("won");
    expect(folderForView("all", "all")).toBe("all");
    expect(folderForView("quoted", "won-mtd")).toBe("quoted");
  });
  it("the leads page sends the adjusted folder to the server and the board", () => {
    const page = read("app/(app)/leads/page.tsx");
    expect(page).toMatch(/folder: folderForView\(folder, smartView\)/);
    expect(page).toMatch(/const cutFolder = folderForView\(folder, smartView\)/);
  });
});

describe("invoice money tiles: tile, list and dashboard agree", () => {
  it("INVOICE_FOCUS matches the page's INVOICE_FOCI", async () => {
    const { INVOICE_FOCI } = await import("@/lib/invoices/kpis");
    const { INVOICE_FOCUS } = await import("./drilldown");
    expect([...INVOICE_FOCUS]).toEqual([...INVOICE_FOCI]);
  });

  it("Company 'Still owed' takes receipts off, like the Outstanding tile", async () => {
    const { invoiceMoney } = await import("@/lib/company/summary");
    const { invoiceKpis } = await import("@/lib/invoices/kpis");
    const now = new Date("2026-10-15T06:30:00Z");
    const invs = [
      { status: "pending", due_date: "2026-10-30", amount: 100_000, paid_amount: 50_000, invoice_date: "2026-10-01" },
      { status: "pending", due_date: "2026-10-30", amount: 20_000, paid_amount: 20_000, invoice_date: "2026-10-01" }, // fully received, not yet flipped
      { status: "paid", due_date: "2026-10-05", amount: 9_000, paid_amount: 9_000, invoice_date: "2026-10-01", paid_date: "2026-10-04" },
    ];
    const co = invoiceMoney(invs, now).outstanding;
    const k = invoiceKpis(invs, now);
    expect(co).toEqual({ count: 1, value: 50_000 });
    expect(k.outstanding).toBe(50_000);
    expect(k.outstandingCount).toBe(1);
    expect(k.paidThisMonthCount).toBe(1);
  });

  it("the invoices page filters by the tile's predicate and shows the banner", () => {
    const page = read("app/(app)/invoices/page.tsx");
    expect(page).toMatch(/useUrlChoice<InvoiceFocus>\("focus", INVOICE_FOCI, ""\)/);
    expect(page).toMatch(/if \(focus && !invoiceInFocus\(i, focus\)\) return false;/);
    expect(page).toMatch(/onClick=\{\(\) => focusOn\("unpaid"\)\}/);
    expect(page).toMatch(/onClick=\{\(\) => focusOn\("paid-month"\)\}/);
    expect(page).toMatch(/<FocusBanner/);
  });
});
