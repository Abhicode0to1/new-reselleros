import { describe, it, expect } from "vitest";
import { subscriptionExceptions } from "./exceptions";

/**
 * These branches do not render in production today — every one of the tenant's
 * 54 subscriptions is normal on every field this reads. That is exactly why they
 * are tested here: on screen, a bug in any of them would look like silence.
 */

const keys = (s: Parameters<typeof subscriptionExceptions>[0]) =>
  subscriptionExceptions(s).map((f) => f.key);

/** A healthy subscription, matching what all 54 production rows look like. */
const HEALTHY = {
  auto_renew: true,
  renewal_state: "pending" as const,
  reminder_count: 0,
  outstanding_amount: 0,
  seats: 5,
  used: 0,
  suspended_at: null,
  written_off_at: null,
};

describe("the silent case — 54 of 54 production rows", () => {
  it("says nothing at all about a healthy subscription", () => {
    // If this ever returns a flag, every row on the page grows a badge that
    // carries no information. That is the whole reason the function is
    // deviation-based.
    expect(subscriptionExceptions(HEALTHY)).toEqual([]);
  });

  it("says nothing when the fields are missing entirely", () => {
    expect(subscriptionExceptions({})).toEqual([]);
  });

  it("treats null/undefined numerics as zero, not as a deviation", () => {
    expect(subscriptionExceptions({
      outstanding_amount: null, used: null, seats: null, reminder_count: null,
    })).toEqual([]);
  });
});

describe("auto_renew off — the silent lapse", () => {
  it("is flagged, in danger tone", () => {
    const [f] = subscriptionExceptions({ ...HEALTHY, auto_renew: false });
    expect(f.key).toBe("auto_renew_off");
    expect(f.tone).toBe("danger");
  });

  it("explains the consequence, not just the state", () => {
    // §24: a block or warning must say what happens next.
    const [f] = subscriptionExceptions({ ...HEALTHY, auto_renew: false });
    expect(f.title).toMatch(/lapse/i);
  });

  it("is NOT flagged when auto_renew is true or unknown", () => {
    expect(keys({ ...HEALTHY, auto_renew: true })).not.toContain("auto_renew_off");
    // `undefined` means "not selected", which is not evidence of it being off.
    expect(keys({ auto_renew: undefined })).not.toContain("auto_renew_off");
  });
});

describe("renewal cadence position — so nobody calls a customer blind", () => {
  it("is silent on the resting state", () => {
    expect(keys({ ...HEALTHY, renewal_state: "pending" })).not.toContain("renewal_state");
  });

  it("surfaces the step and how many reminders already went out", () => {
    const [f] = subscriptionExceptions({ ...HEALTHY, renewal_state: "reminder_3", reminder_count: 4 });
    expect(f.key).toBe("renewal_state");
    expect(f.label).toContain("Reminder 3");
    expect(f.label).toContain("4 sent");
  });

  it("omits the count when nothing has been sent yet", () => {
    // Note the label itself is "Notice sent (T-15)" — the assertion has to look
    // for the appended count, not the word "sent".
    const [f] = subscriptionExceptions({ ...HEALTHY, renewal_state: "notice_sent", reminder_count: 0 });
    expect(f.label).toBe("Notice sent (T-15)");
    expect(f.label).not.toMatch(/\d+ sent/);
  });

  it("carries the cadence tone, so T-30 does not look like a crisis", () => {
    const early = subscriptionExceptions({ ...HEALTHY, renewal_state: "early_notice" })[0];
    const final = subscriptionExceptions({ ...HEALTHY, renewal_state: "final_sent" })[0];
    expect(early.tone).toBe("info");
    expect(final.tone).toBe("danger");
  });

  it("dates the last reminder when one exists", () => {
    const f = subscriptionExceptions({
      ...HEALTHY, renewal_state: "reminder_1", last_reminder_sent_at_v2: "2026-08-01",
    })[0];
    expect(f.title).toMatch(/Last reminder/);
    expect(f.title).toMatch(/2026/);
  });
});

describe("outstanding balance — active service, unpaid money", () => {
  it("is flagged with the amount", () => {
    const [f] = subscriptionExceptions({ ...HEALTHY, outstanding_amount: 16200 });
    expect(f.key).toBe("outstanding");
    expect(f.label).toContain("due");
    expect(f.label).toMatch(/16,200/);   // Indian grouping, via rupee()
  });

  it("is silent at exactly zero, and never shows a negative as due", () => {
    expect(keys({ ...HEALTHY, outstanding_amount: 0 })).not.toContain("outstanding");
    // An over-payment must not read as "₹-500 due".
    expect(keys({ ...HEALTHY, outstanding_amount: -500 })).not.toContain("outstanding");
  });
});

describe("seat utilisation — the honest-silence rule", () => {
  it("stays silent when used is 0, because 0 means UNTRACKED here", () => {
    // Every production row has used = 0 and seats > 0. Flagging that would
    // assert idle licences on 54 subscriptions that are probably fully in use.
    expect(keys({ ...HEALTHY, used: 0, seats: 5 })).not.toContain("low_utilisation");
  });

  it("flags genuinely low utilisation once seats are actually synced", () => {
    expect(keys({ ...HEALTHY, used: 2, seats: 10 })).toContain("low_utilisation");
  });

  it("does not flag healthy utilisation", () => {
    expect(keys({ ...HEALTHY, used: 9, seats: 10 })).not.toContain("low_utilisation");
    expect(keys({ ...HEALTHY, used: 5, seats: 10 })).not.toContain("low_utilisation"); // exactly 50%
  });

  it("does not divide by zero when seats is 0", () => {
    expect(() => subscriptionExceptions({ ...HEALTHY, used: 3, seats: 0 })).not.toThrow();
    expect(keys({ ...HEALTHY, used: 3, seats: 0 })).not.toContain("low_utilisation");
  });
});

describe("suspension and write-off — invisible everywhere before this", () => {
  it("flags an auto-suspended subscription and dates it", () => {
    const [f] = subscriptionExceptions({ ...HEALTHY, suspended_at: "2026-07-15" });
    expect(f.key).toBe("suspended");
    expect(f.title).toMatch(/2026/);
  });

  it("flags a write-off", () => {
    expect(keys({ ...HEALTHY, written_off_at: "2026-06-30" })).toContain("written_off");
  });
});

describe("a subscription in real trouble", () => {
  it("reports every problem at once, worst-first", () => {
    const flags = subscriptionExceptions({
      auto_renew: false,
      renewal_state: "grace_period",
      reminder_count: 5,
      outstanding_amount: 48600,
      seats: 10,
      used: 2,
      suspended_at: "2026-08-01",
      written_off_at: null,
    });
    expect(flags.map((f) => f.key)).toEqual([
      "auto_renew_off", "renewal_state", "outstanding", "low_utilisation", "suspended",
    ]);
    // The lapse warning leads, because it is the one nothing else will catch.
    expect(flags[0].key).toBe("auto_renew_off");
  });

  it("gives every flag a stable unique key, so React never collides", () => {
    const flags = subscriptionExceptions({
      auto_renew: false, renewal_state: "final_sent", outstanding_amount: 100,
      seats: 4, used: 1, suspended_at: "2026-08-01", written_off_at: "2026-08-02",
    });
    expect(new Set(flags.map((f) => f.key)).size).toBe(flags.length);
  });
});
