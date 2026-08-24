import { describe, it, expect } from "vitest";
import { shouldNudge, loopDueAt, type LoopCandidate } from "./sales-loops";

/* ─────────────────────────────────────────────────────────────────────────────
   Should a scheduled follow-up still go out?

   The cron's SQL can only ask "is it due". Everything that makes an automated nudge
   embarrassing happened after the row was written, and none of it is visible to a timestamp
   comparison. These are the four ways a due row is actually stale.
   ───────────────────────────────────────────────────────────────────────────── */

const SCHEDULED_FROM = new Date("2026-08-20T10:00:00Z");

function candidate(over: Partial<LoopCandidate> = {}): LoopCandidate {
  return {
    stage: "quote",
    isJunk: false,
    requiresHumanAttention: false,
    scheduledFrom: SCHEDULED_FROM,
    lastCustomerMessageAt: null,
    ...over,
  };
}

describe("the happy path", () => {
  it("nudges a quiet open lead", () => {
    expect(shouldNudge(candidate()).nudge).toBe(true);
  });

  it("nudges when the customer's last message PREDATES the schedule", () => {
    /* The subtle one. A reply that arrived BEFORE the loop was written is the message the
       agent was already answering when it scheduled this — not a reason to cancel. Comparing
       against "now" instead of against scheduledFrom would cancel every follow-up the agent
       ever set, because the message that triggered it is always in the past. */
    expect(
      shouldNudge(
        candidate({ lastCustomerMessageAt: new Date("2026-08-20T09:59:00Z") }),
      ).nudge,
    ).toBe(true);
  });
});

describe("the customer replied", () => {
  it("does not nudge somebody who has written since", () => {
    /* "Just following up!" landing on top of their own answer is the fastest way to look
       like a robot. */
    const v = shouldNudge(
      candidate({ lastCustomerMessageAt: new Date("2026-08-21T08:00:00Z") }),
    );
    expect(v.nudge).toBe(false);
    if (!v.nudge) expect(v.reason).toBe("customer_replied");
  });
});

describe("the deal is over", () => {
  it("does not nudge a won deal", () => {
    const v = shouldNudge(candidate({ stage: "won" }));
    expect(v.nudge).toBe(false);
    if (!v.nudge) expect(v.reason).toBe("deal_closed");
  });

  it("does not nudge a lost deal", () => {
    const v = shouldNudge(candidate({ stage: "lost" }));
    expect(v.nudge).toBe(false);
    if (!v.nudge) expect(v.reason).toBe("deal_closed");
  });

  it("still nudges mid-pipeline stages", () => {
    /* Only won and lost are terminal. Treating "trial" or "demo" as closed would silence the
       follow-up exactly where it is most useful. */
    for (const stage of ["new", "contact", "demo", "trial", "quote"]) {
      expect(shouldNudge(candidate({ stage })).nudge, stage).toBe(true);
    }
  });
});

describe("a person took it over", () => {
  it("does not nudge a lead flagged for human attention", () => {
    /* The machine talking over a colleague mid-conversation is worse than silence. */
    const v = shouldNudge(candidate({ requiresHumanAttention: true }));
    expect(v.nudge).toBe(false);
    if (!v.nudge) expect(v.reason).toBe("human_took_over");
  });
});

describe("the lead was junked", () => {
  it("does not nudge a junk lead", () => {
    const v = shouldNudge(candidate({ isJunk: true }));
    expect(v.nudge).toBe(false);
    if (!v.nudge) expect(v.reason).toBe("lead_is_junk");
  });

  it("junk wins over everything else", () => {
    /* Checked first on purpose. Somebody rejected this lead; no combination of other facts
       should get a message sent to it. */
    const v = shouldNudge(
      candidate({ isJunk: true, stage: "quote", requiresHumanAttention: false }),
    );
    expect(v.nudge).toBe(false);
    if (!v.nudge) expect(v.reason).toBe("lead_is_junk");
  });
});

describe("every refusal explains itself in words", () => {
  it("gives a sentence, not a code, for each skip", () => {
    /* The detail goes on the lead's timeline. "deal_closed" is for the code; the operator
       reads the sentence. */
    const cases: LoopCandidate[] = [
      candidate({ isJunk: true }),
      candidate({ requiresHumanAttention: true }),
      candidate({ stage: "won" }),
      candidate({ lastCustomerMessageAt: new Date("2026-08-22T08:00:00Z") }),
    ];
    for (const c of cases) {
      const v = shouldNudge(c);
      expect(v.nudge).toBe(false);
      if (!v.nudge) {
        expect(v.detail.length).toBeGreaterThan(15);
        expect(v.detail).not.toContain("_");
      }
    }
  });
});

describe("loopDueAt", () => {
  it("adds whole hours", () => {
    expect(loopDueAt(new Date("2026-08-24T10:00:00Z"), 48).toISOString()).toBe(
      "2026-08-26T10:00:00.000Z",
    );
  });

  it("takes the clock as an argument so the result is testable", () => {
    const a = loopDueAt(new Date("2026-08-24T10:00:00Z"), 1);
    const b = loopDueAt(new Date("2026-08-24T10:00:00Z"), 1);
    expect(a.getTime()).toBe(b.getTime());
  });

  it("does not clamp — SALES_AGENT_SCHEMA already bounds in_hours", () => {
    /* Two places clamping the same value is how they end up disagreeing about the bound. */
    expect(loopDueAt(new Date("2026-08-24T10:00:00Z"), 720).toISOString()).toBe(
      "2026-09-23T10:00:00.000Z",
    );
  });
});
