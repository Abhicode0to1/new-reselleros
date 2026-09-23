import { describe, it, expect } from "vitest";
import { subscriptionFacts, type SubscriptionFactsInput } from "./facts";

const sub = (over: Partial<SubscriptionFactsInput> = {}): SubscriptionFactsInput => ({
  seats: 10, used: 3, mrr: 1360, status: "active", outstanding_amount: 0, ...over,
});

const valueOf = (input: SubscriptionFactsInput, label: string) =>
  subscriptionFacts(input).find((f) => f.label === label)!.value;

describe("subscriptionFacts", () => {
  it("states the four things the row showed and the drawer did not", () => {
    expect(subscriptionFacts(sub()).map((f) => f.label))
      .toEqual(["Status", "Seats", "MRR", "Owed"]);
  });

  it("capitalises the status — it sits beside prose, not in a code block", () => {
    expect(valueOf(sub({ status: "active" }), "Status")).toBe("Active");
    expect(valueOf(sub({ status: "cancelled" }), "Status")).toBe("Cancelled");
  });

  it("says Unknown rather than leaving the status blank", () => {
    expect(valueOf(sub({ status: null }), "Status")).toBe("Unknown");
    expect(valueOf(sub({ status: "  " }), "Status")).toBe("Unknown");
  });

  it("formats money the Indian way", () => {
    expect(valueOf(sub({ mrr: 126720 }), "MRR")).toBe("₹1,26,720/mo");
  });
});

describe("seats — the count that must not lie", () => {
  it("shows usage when it has actually been measured", () => {
    expect(valueOf(sub({ seats: 10, used: 3 }), "Seats")).toBe("3 of 10 used");
  });

  it("shows the licensed count alone when usage is zero", () => {
    /* `used` is 0 both when nobody has logged in AND when the vendor was never asked.
       The list column says NOT TRACKED for the second case; a confident "0 of 10 used"
       here would contradict it, and would read as "this customer bought 10 seats and
       uses none" — a churn signal that may be pure fiction. */
    expect(valueOf(sub({ seats: 10, used: 0 }), "Seats")).toBe("10 licensed");
    expect(valueOf(sub({ seats: 10, used: null }), "Seats")).toBe("10 licensed");
  });

  it("shows a dash when there is no seat count at all", () => {
    expect(valueOf(sub({ seats: 0 }), "Seats")).toBe("—");
    expect(valueOf(sub({ seats: null }), "Seats")).toBe("—");
  });
});

describe("what is owed", () => {
  it("names the amount, and marks it so the drawer can colour it", () => {
    const facts = subscriptionFacts(sub({ outstanding_amount: 19258 }));
    const owed = facts.find((f) => f.label === "Owed")!;
    expect(owed.value).toBe("₹19,258");
    expect(owed.tone).toBe("owed");
  });

  it("says Nothing, not ₹0 — a zero invites a second look", () => {
    const owed = subscriptionFacts(sub({ outstanding_amount: 0 })).find((f) => f.label === "Owed")!;
    expect(owed.value).toBe("Nothing");
    expect(owed.tone).toBe("plain");
  });

  it("treats a missing amount as nothing owed", () => {
    expect(valueOf(sub({ outstanding_amount: null }), "Owed")).toBe("Nothing");
  });

  it("still shows money owed on a subscription that is no longer active", () => {
    // Cancelling service does not cancel the debt. Reading "Cancelled" next to a blank
    // Owed would suggest it was settled.
    const facts = subscriptionFacts(sub({ status: "cancelled", outstanding_amount: 3738 }));
    expect(facts.find((f) => f.label === "Owed")!.value).toBe("₹3,738");
    expect(facts.find((f) => f.label === "Owed")!.tone).toBe("owed");
  });
});
