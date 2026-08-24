import { describe, it, expect } from "vitest";
import {
  shouldAlertUnassigned,
  shouldAutoClose,
  type SlaTicketFacts,
} from "./support-sla";
import { AUTO_CLOSE_AFTER_HOURS, UNASSIGNED_ALERT_AFTER_MINUTES } from "./support-agent";

/* ─────────────────────────────────────────────────────────────────────────────
   The two SLA decisions.

   A `WHERE answered_at < now() - 48h` can only ask "has it been long enough". Everything
   that makes an automatic close WRONG happened after the clock started — the customer
   replied, a colleague took it over, it was escalated — and none of it is visible to a
   timestamp comparison. These are those cases.
   ───────────────────────────────────────────────────────────────────────────── */

const NOW = new Date("2026-08-24T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function ticket(over: Partial<SlaTicketFacts> = {}): SlaTicketFacts {
  return {
    ticketId: "TKT-1",
    status: "resolved",
    awaitingReplySince: hoursAgo(AUTO_CLOSE_AFTER_HOURS + 1),
    lastCustomerMessageAt: null,
    escalated: false,
    escalatedAt: null,
    assignedAgent: null,
    slaAlertSentAt: null,
    ...over,
  };
}

describe("closing a ticket the customer never came back to", () => {
  it("closes after the window, and says why in words the customer's rep can read", () => {
    const v = shouldAutoClose(ticket(), NOW);
    expect(v.close).toBe(true);
    if (v.close) {
      expect(v.detail).toContain(String(AUTO_CLOSE_AFTER_HOURS));
      /* The sentence has to tell somebody what to do next (CLAUDE.md §24) — a closed ticket
         with no route back is a dead end for the customer. */
      expect(v.detail).toContain("reopens");
    }
  });

  it("does not close one second early", () => {
    const v = shouldAutoClose(
      ticket({ awaitingReplySince: hoursAgo(AUTO_CLOSE_AFTER_HOURS - 0.01) }),
      NOW,
    );
    expect(v.close).toBe(false);
    if (!v.close) expect(v.reason).toBe("too_soon");
  });

  it("NEVER closes under the customer's own reply", () => {
    /* The worst thing this sweep could do. A ticket closed on top of a reply reads as being
       ignored, which is the one impression a support desk cannot afford. */
    const v = shouldAutoClose(
      ticket({
        awaitingReplySince: hoursAgo(AUTO_CLOSE_AFTER_HOURS + 5),
        lastCustomerMessageAt: hoursAgo(1),
      }),
      NOW,
    );
    expect(v.close).toBe(false);
    if (!v.close) expect(v.reason).toBe("customer_replied");
  });

  it("ignores a customer message that PREDATES our answer", () => {
    /* The subtle one. A message that arrived before the agent answered is what the agent was
       answering — not a reply to it. Comparing against `now` instead of against
       awaitingReplySince would keep every answered ticket open forever. */
    const v = shouldAutoClose(
      ticket({
        awaitingReplySince: hoursAgo(AUTO_CLOSE_AFTER_HOURS + 1),
        lastCustomerMessageAt: hoursAgo(AUTO_CLOSE_AFTER_HOURS + 2),
      }),
      NOW,
    );
    expect(v.close).toBe(true);
  });

  it("NEVER closes an escalated ticket, however long it has sat", () => {
    /* The silence is ours, not the customer's. Closing it would delete the only signal that
       we still owe an answer. */
    const v = shouldAutoClose(
      ticket({ escalated: true, escalatedAt: hoursAgo(200), awaitingReplySince: hoursAgo(200) }),
      NOW,
    );
    expect(v.close).toBe(false);
    if (!v.close) expect(v.reason).toBe("escalated");
  });

  it("does not close a ticket a colleague owns", () => {
    const v = shouldAutoClose(ticket({ assignedAgent: "user-1" }), NOW);
    expect(v.close).toBe(false);
    if (!v.close) expect(v.reason).toBe("assigned_to_a_person");
  });

  it("does not close a ticket nothing was ever sent on", () => {
    /* awaitingReplySince null means we never answered — the ticket is waiting on US. */
    const v = shouldAutoClose(ticket({ awaitingReplySince: null }), NOW);
    expect(v.close).toBe(false);
    if (!v.close) expect(v.reason).toBe("not_waiting_on_customer");
  });

  it("does not re-close an already closed ticket", () => {
    const v = shouldAutoClose(ticket({ status: "closed" }), NOW);
    expect(v.close).toBe(false);
    if (!v.close) expect(v.reason).toBe("already_closed");
  });

  it("closes an awaiting_customer ticket too, not only a resolved one", () => {
    /* A question they never answered ends the same way as a resolution they never
       acknowledged. */
    const v = shouldAutoClose(ticket({ status: "awaiting_customer" }), NOW);
    expect(v.close).toBe(true);
  });
});

describe("shouting about an escalation nobody has taken", () => {
  const stranded = (over: Partial<SlaTicketFacts> = {}) =>
    ticket({
      status: "open",
      escalated: true,
      escalatedAt: minsAgo(UNASSIGNED_ALERT_AFTER_MINUTES + 10),
      awaitingReplySince: null,
      ...over,
    });

  it("alerts once the wait is past the promise, and reports the real wait", () => {
    const v = shouldAlertUnassigned(stranded(), NOW);
    expect(v.alert).toBe(true);
    if (v.alert) {
      expect(v.waitedMinutes).toBe(UNASSIGNED_ALERT_AFTER_MINUTES + 10);
      /* The sentence names the next step, not just the fact. */
      expect(v.detail).toContain("Assign it");
    }
  });

  it("does not alert before the promise is broken", () => {
    const v = shouldAlertUnassigned(
      stranded({ escalatedAt: minsAgo(UNASSIGNED_ALERT_AFTER_MINUTES - 1) }),
      NOW,
    );
    expect(v.alert).toBe(false);
    if (!v.alert) expect(v.reason).toBe("too_soon");
  });

  it("alerts ONCE — a repeated alarm is one people learn to filter", () => {
    const v = shouldAlertUnassigned(stranded({ slaAlertSentAt: minsAgo(20) }), NOW);
    expect(v.alert).toBe(false);
    if (!v.alert) expect(v.reason).toBe("already_alerted");
  });

  it("stops once somebody has taken the ticket", () => {
    const v = shouldAlertUnassigned(stranded({ assignedAgent: "user-1" }), NOW);
    expect(v.alert).toBe(false);
    if (!v.alert) expect(v.reason).toBe("already_assigned");
  });

  it("does not alert on a ticket that was never escalated", () => {
    const v = shouldAlertUnassigned(stranded({ escalated: false }), NOW);
    expect(v.alert).toBe(false);
    if (!v.alert) expect(v.reason).toBe("not_escalated");
  });

  it("reports a flagged-but-untimed ticket instead of guessing how long it waited", () => {
    /* Escalated with no timestamp should not happen — the dispatcher writes both together.
       Treating it as "escalated a long time ago" would turn one data fault into an alert
       storm, so it is reported with the column named. */
    const v = shouldAlertUnassigned(stranded({ escalatedAt: null }), NOW);
    expect(v.alert).toBe(false);
    if (!v.alert) {
      expect(v.reason).toBe("no_escalation_time");
      expect(v.detail).toContain("ai_escalated_at");
    }
  });
});

describe("the two decisions do not overlap", () => {
  it("an escalated, unassigned, long-waiting ticket alerts and is NOT closed", () => {
    /* Both sweeps see this row. One must act and the other must not, and getting that
       backwards would close the ticket that most needs answering. */
    const t = ticket({
      status: "open",
      escalated: true,
      escalatedAt: hoursAgo(50),
      awaitingReplySince: hoursAgo(50),
      assignedAgent: null,
    });
    expect(shouldAutoClose(t, NOW).close).toBe(false);
    expect(shouldAlertUnassigned(t, NOW).alert).toBe(true);
  });
});

describe("an escalation somebody dealt with WITHOUT assigning it", () => {
  /* Measured on a probe, 24 Aug 2026: neither this decision nor its query looked at `status`.
     The ordinary way a rep handles an escalation — answer it and close it, without first
     assigning it to themselves — would leave it alerting on every sweep for the rest of time.
     An alarm that keeps firing about a handled ticket is one people learn to filter. */

  const stranded = (over: Partial<SlaTicketFacts> = {}) =>
    ticket({
      status: "open",
      escalated: true,
      escalatedAt: minsAgo(UNASSIGNED_ALERT_AFTER_MINUTES + 10),
      awaitingReplySince: null,
      ...over,
    });

  it("does not alert on a CLOSED escalation", () => {
    const v = shouldAlertUnassigned(stranded({ status: "closed" }), NOW);
    expect(v.alert).toBe(false);
    if (!v.alert) {
      expect(v.reason).toBe("already_handled");
      expect(v.detail).toContain("closed");
    }
  });

  it("does not alert on a RESOLVED escalation", () => {
    const v = shouldAlertUnassigned(stranded({ status: "resolved" }), NOW);
    expect(v.alert).toBe(false);
    if (!v.alert) expect(v.reason).toBe("already_handled");
  });

  it("STILL alerts on the statuses that mean nobody has answered", () => {
    /* The boundary. These three are exactly "the customer is still waiting", and the whole
       point of the alert is that one of them has been true for too long. */
    for (const status of ["open", "in_progress", "awaiting_customer"]) {
      expect(shouldAlertUnassigned(stranded({ status }), NOW).alert, status).toBe(true);
    }
  });
});
