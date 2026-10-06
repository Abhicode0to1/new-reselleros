/**
 * R-115 — a quote a person sends from the app gets the same chase the AI's quotes get, and
 * the chase stops once the customer has answered the quote itself.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CADENCE, firstChaseAfterSend } from "./cadence";
import { shouldNudge } from "./sales-loops";

describe("firstChaseAfterSend", () => {
  const sent = new Date("2026-10-02T10:00:00Z");

  it("plans step 2 of the cadence, two days after the send", () => {
    const c = firstChaseAfterSend(sent)!;
    expect(c.step).toBe(2);
    expect(c.inHours).toBe(48);
    expect(c.channel).toBe(CADENCE[1].channel);
    expect(c.triggerCondition).toBe(CADENCE[1].intent);
  });

  it("is anchored to the send, not to when it is computed", () => {
    expect(firstChaseAfterSend(sent, new Date("2026-10-03T10:00:00Z"))!.inHours).toBe(24);
  });

  it("never schedules in the past", () => {
    expect(firstChaseAfterSend(sent, new Date("2026-10-09T10:00:00Z"))!.inHours).toBe(1);
  });
});

describe("shouldNudge — a settled quote ends the chase", () => {
  const base = {
    stage: "quote", isJunk: false, requiresHumanAttention: false,
    scheduledFrom: new Date("2026-10-02T10:00:00Z"), lastCustomerMessageAt: null,
  };

  it("stops when the quote is accepted, rejected or paid", () => {
    const v = shouldNudge({ ...base, quoteSettled: true });
    expect(v).toMatchObject({ nudge: false, reason: "quote_settled" });
  });

  it("still nudges an open quote, and callers that never pass it are unchanged", () => {
    expect(shouldNudge({ ...base, quoteSettled: false }).nudge).toBe(true);
    expect(shouldNudge(base).nudge).toBe(true);
  });
});

describe("wiring", () => {
  const send = readFileSync(join(__dirname, "../../app/api/quotes/[id]/send/route.ts"), "utf8");
  const cron = readFileSync(join(__dirname, "../../app/api/cron/ai-sales-loop/route.ts"), "utf8");

  it("the Send button plans the chase only on the first real send", () => {
    expect(send).toMatch(/quote\.status === "draft" && sendResult\.status === "sent"/);
    expect(send).toMatch(/scheduleSalesLoop\(\{ tenantId: quote\.tenant_id, leadId: quote\.lead_id, \.\.\.chase \}\)/);
  });

  it("the cron tells shouldNudge whether the quote is settled", () => {
    expect(cron).toMatch(/quoteSettled: quoteRow\.settled/);
    expect(cron).toMatch(/payment_status === "paid"/);
  });
});
