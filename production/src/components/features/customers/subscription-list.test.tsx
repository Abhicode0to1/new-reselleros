// @vitest-environment jsdom
//
// One question: can the owner tell a settled subscription from one that owes money?
//
// Before this, no. The card printed the balance only when it was above zero, so a paid
// subscription rendered NOTHING and blank space was left carrying the meaning of the word
// "Paid". Pardeep hit it on a real customer: three active subscriptions, one showing
// "₹18,232 due" and two showing nothing at all, with no way to know if that was good news.
//
// Two states only. `subscriptions.outstanding_amount` is NOT NULL DEFAULT 0 (measured, not
// assumed) and `number` in the row type, so there is no "unknown" case to cover — an
// assertion for one would be testing a state the schema cannot produce.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SubscriptionList } from "./customer-insights";
import type { Subscription } from "@/lib/supabase/database.types";

afterEach(cleanup);

const sub = (over: Partial<Subscription>): Subscription => ({
  id: "sub-1",
  plan: "Google Workspace Business Starter",
  status: "active",
  mrr: 2700,
  seats: 10,
  used: 0,
  start_date: "2026-08-21",
  renewal_date: "2027-08-21",
  outstanding_amount: 0,
  ...over,
} as Subscription);

describe("whether a subscription's money is settled", () => {
  it("says Paid instead of saying nothing", () => {
    /* The whole point. A blank space cannot be read as an assurance — somebody checking
       whether they have been paid needs the screen to answer. */
    render(<SubscriptionList subs={[sub({ outstanding_amount: 0 })]} />);
    expect(screen.getByText("Paid")).toBeTruthy();
  });

  it("still shows the amount when money is owed", () => {
    render(<SubscriptionList subs={[sub({ id: "s2", outstanding_amount: 18232 })]} />);
    expect(screen.getByText(/18,232 due/)).toBeTruthy();
    /* Never both — "Paid" beside a balance due is worse than either alone. */
    expect(screen.queryByText("Paid")).toBeNull();
  });

  it("tells them apart on one screen, which is how it is actually read", () => {
    /* Pardeep was looking at a list, not a single card, and two of these rows used to be
       indistinguishable from each other. */
    render(
      <SubscriptionList
        subs={[
          sub({ id: "a", outstanding_amount: 18232 }),
          sub({ id: "b", outstanding_amount: 0 }),
          sub({ id: "c", outstanding_amount: 0 }),
        ]}
      />,
    );
    expect(screen.getByText(/18,232 due/)).toBeTruthy();
    expect(screen.getAllByText("Paid")).toHaveLength(2);
  });
});
