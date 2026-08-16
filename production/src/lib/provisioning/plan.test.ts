import { describe, it, expect } from "vitest";
import {
  planProvisioning, vendorFromPlanName, provisionTaskTitle, overallProvisionStatus,
  API_ENABLED_VENDORS, vendorLabel,
} from "./plan";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

const line = (over: Partial<QuoteLineItem> = {}): QuoteLineItem => ({
  id: "l1", name: "Google Workspace Business Starter", qty: 10, rate: 3240, cost: 1320, ...over,
});

describe("no vendor API is wired, and the code says so", () => {
  it("API_ENABLED_VENDORS is empty", () => {
    /* Adding a vendor here without its client and credential would make every task
       claim to be automatic and then never run. */
    expect(API_ENABLED_VENDORS).toEqual([]);
  });

  it("every task is manual, with the reason attached", () => {
    const { items } = planProvisioning({ lines: [line()] });
    expect(items[0].mode).toBe("manual");
    expect(items[0].manualReason).toMatch(/No Google Workspace reseller API is connected/);
  });
});

describe("planProvisioning", () => {
  it("works out vendor, seats and domain per line", () => {
    const { items } = planProvisioning({
      lines: [line({ qty: 25, domain: "acme.in" })],
    });
    expect(items[0]).toMatchObject({ vendor: "google", seats: 25, domain: "acme.in" });
  });

  it("falls back to the quote-level domain", () => {
    const { items } = planProvisioning({ lines: [line()], fallbackDomain: "acme.in" });
    expect(items[0].domain).toBe("acme.in");
  });

  it("leaves the domain null rather than inventing one", () => {
    expect(planProvisioning({ lines: [line()] }).items[0].domain).toBeNull();
  });

  it("handles several vendors on one quote", () => {
    const { items } = planProvisioning({ lines: [
      line({ id: "a", name: "Google Workspace Business Starter" }),
      line({ id: "b", name: "Microsoft 365 Business Premium", qty: 5 }),
      line({ id: "c", name: "Zoho Workplace Standard", qty: 3 }),
    ] });
    expect(items.map((i) => [i.vendor, i.seats])).toEqual([["google", 10], ["microsoft", 5], ["zoho", 3]]);
  });
});

describe("what is skipped is RECORDED, not dropped", () => {
  it("a line whose name identifies no vendor", () => {
    /* A silently missing line is how a customer pays for a product nobody delivers —
       but "provision 10 seats of something, somewhere" is a task a rep cannot action
       and will learn to ignore. So it is recorded, not turned into a task. */
    const r = planProvisioning({ lines: [line({ name: "Annual Support Retainer" })] });
    expect(r.items).toEqual([]);
    expect(r.skipped[0]).toMatchObject({ name: "Annual Support Retainer" });
    expect(r.skipped[0].reason).toMatch(/identifies a vendor/);
  });

  it("a line with no seats", () => {
    const r = planProvisioning({ lines: [line({ qty: 0 })] });
    expect(r.items).toEqual([]);
    expect(r.skipped[0].reason).toBe("No seats on this line.");
  });

  it("an empty quote produces nothing and complains about nothing", () => {
    expect(planProvisioning({ lines: [] })).toEqual({ items: [], skipped: [] });
  });
});

describe("vendorFromPlanName", () => {
  it.each([
    ["Google Workspace Business Starter", "google"],
    ["GWS Enterprise",                    "google"],
    ["Microsoft 365 Business Premium",    "microsoft"],
    ["Office 365 E3",                     "microsoft"],
    ["Zoho Workplace Standard",           "zoho"],
  ] as const)("%s → %s", (name, vendor) => {
    expect(vendorFromPlanName(name)).toBe(vendor);
  });

  it("returns null rather than guessing", () => {
    for (const n of ["Tally Prime Gold", "", null, undefined]) {
      expect(vendorFromPlanName(n as string | null)).toBeNull();
    }
  });
});

describe("provisionTaskTitle", () => {
  it("is one line a rep can act on without opening anything", () => {
    const { items } = planProvisioning({ lines: [line({ qty: 25, domain: "acme.in" })] });
    expect(provisionTaskTitle(items[0]))
      .toBe("Create 25 seats of Google Workspace Business Starter on acme.in");
  });

  it("names the missing domain as the next question, not as a blank", () => {
    const { items } = planProvisioning({ lines: [line({ qty: 1 })] });
    expect(provisionTaskTitle(items[0])).toMatch(/domain not captured, ask the customer/);
    expect(provisionTaskTitle(items[0])).toContain("1 seat of");
  });
});

describe("overallProvisionStatus", () => {
  it.each([
    [[], "not_required"],
    [["done", "done"], "done"],
    [["done", "pending"], "pending"],
    [["pending", "in_progress"], "in_progress"],
    [["done", "failed", "pending"], "failed"],
    [["not_required", "not_required"], "not_required"],
    [["not_required", "done"], "done"],
  ] as const)("%j → %s", (statuses, expected) => {
    expect(overallProvisionStatus(statuses as never)).toBe(expected);
  });

  it("a quote with nothing to provision is SETTLED, not stuck", () => {
    /* An empty task list showing an unfinished step would leave every services-only
       quote permanently incomplete. */
    expect(overallProvisionStatus([])).toBe("not_required");
  });

  it("one failure outranks everything — it must not hide behind completed work", () => {
    expect(overallProvisionStatus(["done", "done", "failed"])).toBe("failed");
  });
});

describe("vendorLabel", () => {
  it("names each vendor the way a customer would", () => {
    expect(vendorLabel("google")).toBe("Google Workspace");
    expect(vendorLabel("microsoft")).toBe("Microsoft 365");
  });
});
