import { describe, it, expect } from "vitest";
import { normalisePostCall, sentimentOf } from "./inbound";

const RETELL = {
  event: "call_analyzed",
  call: {
    call_id: "call_abc123",
    call_status: "ended",
    disconnection_reason: "customer-ended-call",
    start_timestamp: 1_756_000_000_000,
    end_timestamp: 1_756_000_120_000,
    transcript: "Agent: Hello...\nUser: Send me a quote for twelve seats.",
    call_analysis: {
      call_summary: "Customer wants 12 seats of Business Standard.",
      user_sentiment: "Positive",
      custom_analysis_data: {
        customer_asked_for_quote: true,
        seats_discussed: 12,
      },
    },
    metadata: {
      tenant_id: "fbb976f1-9090-4f10-9726-0901bd144e42",
      call_type: "lead_qualification",
      lead_id: "L-0007",
      subscription_id: "",
    },
  },
};

const VAPI = {
  message: {
    type: "end-of-call-report",
    endedReason: "customer-ended-call",
    durationSeconds: 95,
    call: {
      id: "vapi_xyz789",
      metadata: {
        tenant_id: "fbb976f1-9090-4f10-9726-0901bd144e42",
        call_type: "renewal_reminder",
        lead_id: "",
        subscription_id: "0f2b1f2c-1111-4222-8333-444455556666",
      },
    },
    artifact: { transcript: "Agent: Your renewal is due...\nUser: Yes, we will continue." },
    analysis: {
      summary: "Customer confirmed renewal.",
      structuredData: {
        customer_confirmed_renewal: "true",
        sentiment: "neutral",
      },
    },
  },
};

describe("Retell post-call reports", () => {
  it("reads the call id, the transcript and the metadata we set", () => {
    const n = normalisePostCall(RETELL);
    expect(n?.provider).toBe("retell");
    expect(n?.providerCallId).toBe("call_abc123");
    expect(n?.leadId).toBe("L-0007");
    expect(n?.callType).toBe("lead_qualification");
    expect(n?.signals.transcript).toContain("twelve seats");
  });

  it("prefers the disconnection reason over the status word", () => {
    /* `call_status` says "ended" for a voicemail beep and for a ten-minute conversation alike,
       and those are not the same call. */
    expect(normalisePostCall(RETELL)?.signals.disposition).toBe("customer-ended-call");
  });

  it("computes the duration from the timestamps", () => {
    expect(normalisePostCall(RETELL)?.signals.durationSec).toBe(120);
  });

  it("turns an empty metadata string into null, not into an id", () => {
    /* `subscription_id: ""` must not become a lookup for the empty id. */
    expect(normalisePostCall(RETELL)?.subscriptionId).toBeNull();
  });

  it("reads the structured analysis flags", () => {
    const n = normalisePostCall(RETELL);
    expect(n?.signals.customerAskedForQuote).toBe(true);
    expect(n?.signals.seatsDiscussed).toBe(12);
    expect(n?.analysisMissing).toBe(false);
  });
});

describe("Vapi post-call reports", () => {
  it("reads the same fields out of a different shape", () => {
    const n = normalisePostCall(VAPI);
    expect(n?.provider).toBe("vapi");
    expect(n?.providerCallId).toBe("vapi_xyz789");
    expect(n?.subscriptionId).toBe("0f2b1f2c-1111-4222-8333-444455556666");
    expect(n?.callType).toBe("renewal_reminder");
    expect(n?.signals.durationSec).toBe(95);
    expect(n?.signals.customerConfirmedRenewal).toBe(true);
  });

  it('accepts "true" as well as true, because models emit both', () => {
    expect(normalisePostCall(VAPI)?.signals.customerConfirmedRenewal).toBe(true);
  });
});

describe("the outcome is never inferred from the transcript", () => {
  it("does not read 'quote' out of the words when there is no structured analysis", () => {
    /* THE TEST THIS MODULE EXISTS FOR. The transcript below contains the word "quote" in a
       sentence that DECLINES one. A keyword match here would not produce a slightly worse
       decision — it would email a quotation to somebody who explicitly said no. */
    const declined = {
      call: {
        call_id: "call_decline",
        disconnection_reason: "customer-ended-call",
        duration_ms: 60_000,
        transcript: "User: No, please don't send me a quote. We are not interested.",
        metadata: { tenant_id: "t", call_type: "lead_qualification", lead_id: "L-1" },
      },
    };
    const n = normalisePostCall(declined);
    expect(n?.signals.customerAskedForQuote).toBe(false);
    expect(n?.analysisMissing).toBe(true);
  });

  it("reports a missing analysis rather than defaulting to something", () => {
    const noAnalysis = {
      message: {
        call: { id: "v1", metadata: {} },
        endedReason: "completed",
        durationSeconds: 60,
        artifact: { transcript: "..." },
      },
    };
    const n = normalisePostCall(noAnalysis);
    expect(n?.analysisMissing).toBe(true);
    expect(n?.signals.customerAskedForQuote).toBe(false);
    expect(n?.signals.customerConfirmedRenewal).toBe(false);
  });

  it('treats "maybe" as false, because it is not consent', () => {
    const maybe = {
      call: {
        call_id: "c",
        disconnection_reason: "completed",
        metadata: {},
        call_analysis: { custom_analysis_data: { customer_asked_for_quote: "maybe" } },
      },
    };
    expect(normalisePostCall(maybe)?.signals.customerAskedForQuote).toBe(false);
  });
});

describe("payloads this app should not act on", () => {
  it.each([
    [null, "null"],
    ["a string", "a bare string"],
    [{}, "an empty object"],
    [{ call: { call_status: "ended" } }, "a Retell body with no call id"],
    [{ message: { type: "status-update" } }, "a Vapi body with no call id"],
    [{ something: "else" }, "a shape from neither vendor"],
  ])("returns null for %s (%s)", (payload, why) => {
    expect(normalisePostCall(payload), `should not act on ${why}`).toBeNull();
  });

  it("never half-succeeds", () => {
    /* Total, not partial. A normaliser that returns a half-filled object hands the next layer
       a record that looks complete — `support-inbound.ts` is the same shape for the same
       reason. */
    expect(normalisePostCall({ call: { transcript: "hello" } })).toBeNull();
  });
});

describe("sentimentOf", () => {
  it("reads Retell's user_sentiment", () => {
    expect(sentimentOf(RETELL)).toBe("Positive");
  });

  it("reads Vapi's structured sentiment", () => {
    expect(sentimentOf(VAPI)).toBe("neutral");
  });

  it("returns null when nobody said", () => {
    expect(sentimentOf({ call: { call_id: "x" } })).toBeNull();
    expect(sentimentOf(null)).toBeNull();
  });
});
