import { describe, it, expect } from "vitest";
import {
  noticeDueFor,
  noticeSubject,
  NOTICE_STEPS,
  type RenewalNoticeStep,
  type DomainNoticeStatus,
} from "./renewal-notice";

const TODAY = "2026-09-11";

/**
 * `TODAY` plus n days, as an ISO date.
 *
 * Built in UTC on purpose. The first version of this used
 * `new Date("2026-09-11T00:00:00+05:30")` and then `.toISOString()`, which is
 * 2026-09-10T18:30Z — so every date came out a day early and every assertion in
 * this file failed by one step. The helper was wrong, not the function.
 */
const inDays = (n: number) => {
  const [y, m, d] = TODAY.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

const ask = (o: {
  days?: number;
  expiresAt?: string | null;
  status?: DomainNoticeStatus;
  sent?: RenewalNoticeStep[];
}) =>
  noticeDueFor({
    expiresAt: o.expiresAt !== undefined ? o.expiresAt : inDays(o.days ?? 0),
    status: o.status ?? "active",
    today: TODAY,
    alreadySent: o.sent ?? [],
  });

describe("the ladder", () => {
  it("is nearest-first, which is what stops a catch-up burst", () => {
    expect(NOTICE_STEPS.map((s) => s.daysBefore)).toEqual([1, 7, 14, 30]);
  });
});

describe("noticeDueFor — which step, on a clean slate", () => {
  it.each([
    [30, "d30"],
    [29, "d30"],
    [15, "d30"],
    [14, "d14"],
    [8, "d14"],
    [7, "d7"],
    [2, "d7"],
    [1, "d1"],
    [0, "d1"],
  ])("%i days left → %s", (days, step) => {
    expect(ask({ days })?.step).toBe(step);
  });

  it("says nothing more than 30 days out", () => {
    expect(ask({ days: 31 })).toBeNull();
    expect(ask({ days: 90 })).toBeNull();
    expect(ask({ days: 365 })).toBeNull();
  });

  it("carries the days left, so the copy does not have to recompute it", () => {
    expect(ask({ days: 11 })?.daysLeft).toBe(11);
    expect(ask({ days: 1 })?.daysLeft).toBe(1);
  });
});

describe("noticeDueFor — one notice per step, never twice", () => {
  it("goes quiet once the current step has been sent", () => {
    expect(ask({ days: 11, sent: ["d14"] })).toBeNull();
  });

  it("moves to the next step as the date closes in", () => {
    expect(ask({ days: 6, sent: ["d14"] })?.step).toBe("d7");
    expect(ask({ days: 1, sent: ["d14", "d7"] })?.step).toBe("d1");
  });

  it("goes quiet when everything has been sent", () => {
    expect(ask({ days: 1, sent: ["d30", "d14", "d7", "d1"] })).toBeNull();
  });

  /* ─── THE RULE THAT MATTERS MOST ──────────────────────────────────────────
     A domain first seen five days before expiry gets ONE notice, not three.
     Three warnings about one domain in one minute teaches a customer to ignore
     all of them, which is worse than the silence this replaces. */
  it("a domain discovered late gets ONE notice, not the whole ladder", () => {
    const first = ask({ days: 5 });
    expect(first?.step).toBe("d7");
    /* And having sent it, nothing else fires today — the 14 and the 30 are
       never delivered for a term that is already inside 7 days. */
    expect(ask({ days: 5, sent: ["d7"] })).toBeNull();
  });

  it("never sends a step for a window that has already passed", () => {
    /* 3 days left: d14 and d30 must never be chosen, sent or not. */
    for (const sent of [[], ["d1"], ["d7"], ["d1", "d7"]] as RenewalNoticeStep[][]) {
      const r = ask({ days: 3, sent });
      if (r) expect(["d7", "d1"]).toContain(r.step);
    }
  });
});

describe("noticeDueFor — after it lapses", () => {
  it("sends one lapsed notice while the name can still be recovered", () => {
    const r = ask({ days: -1, status: "grace" });
    expect(r?.step).toBe("lapsed");
    expect(r?.alreadyLapsed).toBe(true);
    expect(r?.daysLeft).toBe(-1);
  });

  it("sends the lapsed notice ONCE, not once a day", () => {
    expect(ask({ days: -1, status: "grace", sent: ["lapsed"] })).toBeNull();
    expect(ask({ days: -9, status: "grace", sent: ["lapsed"] })).toBeNull();
  });

  it("sends it even when the earlier steps never went out", () => {
    /* A domain imported after it had already lapsed. The lapsed notice is the
       only useful one, and it must not be blocked by the unsent ladder. */
    expect(ask({ days: -9, status: "grace", sent: [] })?.step).toBe("lapsed");
  });

  /* Once RC reports it `expired` the name has dropped. Inviting a customer to
     pay for something we cannot get back is worse than saying nothing. */
  it("says nothing once the domain has actually dropped", () => {
    expect(ask({ days: -40, status: "expired" })).toBeNull();
  });
});

describe("noticeDueFor — rows it refuses to warn about", () => {
  it("says nothing without an expiry date", () => {
    expect(ask({ expiresAt: null })).toBeNull();
  });

  it.each<DomainNoticeStatus>(["pending", "transferred_out", "failed"])(
    "says nothing for a %s domain",
    (status) => {
      expect(ask({ days: 3, status })).toBeNull();
      expect(ask({ days: -3, status })).toBeNull();
    },
  );

  /* `pending` is the paid-but-undelivered case and that has its own screen. A
     renewal warning there would tell a customer their domain is expiring when it
     was never registered. */
  it("a pending domain with an expiry is still silent", () => {
    expect(ask({ days: 2, status: "pending", expiresAt: inDays(2) })).toBeNull();
  });
});

describe("noticeSubject — plain, and never a price", () => {
  it("names the domain and the urgency", () => {
    expect(noticeSubject("acmecorp.com", { step: "d14", daysLeft: 11, alreadyLapsed: false }))
      .toBe("acmecorp.com expires in 11 days");
    expect(noticeSubject("acmecorp.com", { step: "d1", daysLeft: 1, alreadyLapsed: false }))
      .toBe("acmecorp.com expires tomorrow");
    expect(noticeSubject("acme-legacy.net", { step: "lapsed", daysLeft: -9, alreadyLapsed: true }))
      .toBe("acme-legacy.net has expired — it can still be renewed");
  });

  it("says 'tomorrow' rather than 'in 0 days' on the last day", () => {
    expect(noticeSubject("x.in", { step: "d1", daysLeft: 0, alreadyLapsed: false }))
      .toBe("x.in expires tomorrow");
  });

  /* A figure here would be a number the quote then contradicts — a renewal is
     priced from the rate card when the quote is raised. Same discipline as the
     hosting upgrade and seat requests. */
  it("carries no amount at all", () => {
    for (const d of [
      { step: "d30" as const, daysLeft: 30, alreadyLapsed: false },
      { step: "lapsed" as const, daysLeft: -2, alreadyLapsed: true },
    ]) {
      expect(noticeSubject("acmecorp.com", d)).not.toMatch(/₹|\d+\.\d\d|rupee/i);
    }
  });
});
