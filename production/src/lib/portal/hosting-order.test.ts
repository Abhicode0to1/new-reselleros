/**
 * A portal hosting order has to survive two journeys: into integer money
 * columns, and back out through a webhook that has to recognise what was sold.
 *
 * The second is the one worth the test. If `item_id` or the plan label is wrong,
 * the payment still captures, `record_payment` still runs, the invoice still
 * raises — and provisioning is simply never queued. There is no error to find,
 * no failed row, nothing in the logs: a customer pays for hosting and no account
 * is ever made. So these assert against the ACTUAL predicates the webhook uses,
 * copied from src/app/api/webhooks/razorpay/route.ts rather than described.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  hostingOrderTotals,
  hostingPlanLabel,
  hostingLineItem,
  HOSTING_GST_RATE,
} from "./hosting-order";

describe("the money stays in whole rupees (§13)", () => {
  it("adds 18% GST", () => {
    expect(hostingOrderTotals(199)).toEqual({ subtotal: 199, amount: 235, taxRate: 18 });
    expect(hostingOrderTotals(499)).toEqual({ subtotal: 499, amount: 589, taxRate: 18 });
    expect(hostingOrderTotals(999)).toEqual({ subtotal: 999, amount: 1179, taxRate: 18 });
  });

  /* The DMS engine publishes 49.99. `quotes.subtotal` and `quotes.amount` are
     integer columns, so a fraction reaching them is a write that either fails or
     truncates depending on the driver. */
  it("rounds a fractional catalogue price before it reaches an integer column", () => {
    const t = hostingOrderTotals(49.99);
    expect(Number.isInteger(t.subtotal), `subtotal ${t.subtotal} is not an integer`).toBe(true);
    expect(Number.isInteger(t.amount), `amount ${t.amount} is not an integer`).toBe(true);
    expect(t.subtotal).toBe(50);
    expect(t.amount).toBe(59);
  });

  it("never produces a negative or NaN total", () => {
    for (const bad of [-100, NaN, Number.POSITIVE_INFINITY]) {
      const t = hostingOrderTotals(bad as number);
      expect(Number.isInteger(t.subtotal), `subtotal from ${bad}`).toBe(true);
      expect(t.subtotal).toBeGreaterThanOrEqual(0);
      expect(t.amount).toBeGreaterThanOrEqual(0);
    }
  });

  it("GST is a constant, not a number typed twice", () => {
    expect(HOSTING_GST_RATE).toBe(18);
    expect(hostingOrderTotals(100).taxRate).toBe(HOSTING_GST_RATE);
  });
});

/* ─── THE WEBHOOK'S OWN PREDICATES ──────────────────────────────────────────
   Read out of the route rather than restated, so that if someone changes how
   the webhook identifies a hosting order, these fail instead of quietly
   continuing to assert an obsolete contract. */
const WEBHOOK = readFileSync(
  join(process.cwd(), "src/app/api/webhooks/razorpay/route.ts"),
  "utf8",
);

describe("the webhook can still tell what was bought", () => {
  it("the webhook really does read item_id off the line items", () => {
    expect(
      /item_id\?:\s*unknown/.test(WEBHOOK) || /\.item_id/.test(WEBHOOK),
      "vendorForQuote no longer reads `item_id` — this module's line shape may be talking to nobody",
    ).toBe(true);
  });

  it("the line carries the catalogue id the webhook resolves the vendor from", () => {
    const line = hostingLineItem({
      quoteId: "Q-2222-2026-27-0001",
      itemId: "HOST-STARTER-222222",
      planName: "Starter Hosting",
      domain: "newsite.co.in",
      rate: 199,
    });
    expect(line.item_id).toBe("HOST-STARTER-222222");
    expect(line.qty).toBe(1);
    expect(Number.isInteger(line.rate)).toBe(true);
    // The name is what the customer sees on the invoice line.
    expect(line.name).toBe("Starter Hosting — newsite.co.in");
  });

  /* vendorFromPlan: `if (p.includes("hosting") || p.includes("cpanel")) return "hosting"`.
     The fallback only fires when a line has no item_id, but it is the difference
     between "provisioned late" and "never provisioned" when it does. */
  it("the plan label satisfies the webhook's fallback test", () => {
    for (const id of ["starter", "STANDARD", "HOST-PLUS-222222", ""]) {
      const label = hostingPlanLabel(id);
      expect(label.includes("hosting"), `"${label}" would not be recognised as hosting`).toBe(true);
      expect(label).toBe(label.toLowerCase());
    }
  });

  it("matches the shape the public cart writes, so one webhook reads both", () => {
    // cart/route.ts: `const planLabel = hostingTier ? \`hosting-${hostingTier}\` : "cart-order"`
    expect(hostingPlanLabel("starter")).toBe("hosting-starter");
  });

  it("the webhook's own fallback predicate still looks for this word", () => {
    expect(
      /includes\("hosting"\)/.test(WEBHOOK),
      "vendorFromPlan no longer matches on 'hosting' — hostingPlanLabel is now shaped for nothing",
    ).toBe(true);
  });
});
