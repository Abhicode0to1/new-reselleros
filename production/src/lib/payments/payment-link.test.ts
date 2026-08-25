import { describe, it, expect } from "vitest";
import {
  decidePaymentLink,
  paymentLinkMessage,
  paymentLinkRequest,
  toPaise,
  type PaymentLinkInput,
} from "./payment-link";

const OK: PaymentLinkInput = {
  mode: "live",
  configured: true,
  amountDue: 146_811,
  quoteStatus: "sent",
  contact: "buyer@acme.in",
};

describe("toPaise — the one unit boundary in this file", () => {
  it("converts the real quote total exactly", () => {
    /* ₹1,46,811 is Q-ADPL-2026-27-0058's incl-GST amount. This schema stores WHOLE RUPEES
       (CLAUDE.md §13, which says so in a correction because the file once claimed paise) and
       Razorpay's API takes paise. Get the direction wrong and we ask a real person for
       ₹1,468 or ₹1,46,81,100. */
    expect(toPaise(146_811)).toBe(14_681_100);
  });

  it.each([
    [1, 100],
    [270, 27_000],
    [3_240, 324_000],
    [1_24_416, 12_441_600],
  ])("converts ₹%i to %i paise", (rupees, paise) => {
    expect(toPaise(rupees)).toBe(paise);
  });

  it("never produces a fractional paisa", () => {
    /* `quotes.amount` is an integer column, so a non-integer here means something upstream is
       already wrong — and Razorpay would reject it. Rounding is the safe response. */
    expect(toPaise(100.4)).toBe(10_000);
    expect(toPaise(100.6)).toBe(10_100);
    expect(Number.isInteger(toPaise(99.999))).toBe(true);
  });
});

describe("decidePaymentLink", () => {
  it("creates a link for a sent quote with money outstanding", () => {
    const d = decidePaymentLink(OK);
    expect(d.create).toBe(true);
  });

  it("refuses when nothing is outstanding", () => {
    /* `quoteAmountDue` returns 0 for money already collected OR already asked for on an
       invoice. Two documents collecting the same amount is how a customer pays twice — the
       failure that guard exists to prevent on the UPI QR path. */
    const d = decidePaymentLink({ ...OK, amountDue: 0 });
    expect(d.create).toBe(false);
    if (!d.create) {
      expect(d.reason).toBe("already_paid");
      expect(d.detail).toContain("collect it twice");
    }
  });

  it("refuses a draft — the customer has never seen it", () => {
    const d = decidePaymentLink({ ...OK, quoteStatus: "draft" });
    expect(d.create).toBe(false);
    if (!d.create) expect(d.reason).toBe("not_sendable");
  });

  it("refuses when Razorpay is not connected, and names the screen", () => {
    const d = decidePaymentLink({ ...OK, configured: false });
    expect(d.create).toBe(false);
    if (!d.create) expect(d.detail).toContain("Settings → Integrations");
  });

  it("puts 'already paid' AHEAD of 'no contact'", () => {
    /* Ordering is the assertion. Finding an address would not make a second link for a settled
       quote correct. */
    const d = decidePaymentLink({ ...OK, amountDue: 0, contact: null });
    if (!d.create) expect(d.reason).toBe("already_paid");
  });

  it("LABELS a test-mode link instead of quietly proceeding", () => {
    /* Production's key starts rzp_test_. A test link takes a payment, fires payment.captured,
       and settles nothing — so anything downstream treating it as revenue is wrong, and the
       operator needs to know which kind of link they just sent. */
    const d = decidePaymentLink({ ...OK, mode: "test" });
    expect(d.create).toBe(true);
    if (d.create) {
      expect(d.mode).toBe("test");
      expect(d.note).toContain("settles no money");
    }
  });

  it("adds no note for a live link", () => {
    const d = decidePaymentLink(OK);
    if (d.create) expect(d.note).toBeNull();
  });
});

describe("paymentLinkRequest", () => {
  const req = () =>
    paymentLinkRequest({
      quoteId: "Q-ADPL-2026-27-0058",
      amountDue: 146_811,
      customerName: "Rahul Solutions",
      customerEmail: "rahul@acme.in",
      customerPhone: "+919876543210",
      sellerName: "ANUTECH DIGITAL PVT LTD",
      tenantId: "fbb976f1-9090-4f10-9726-0901bd144e42",
      expiresOn: "2099-01-01",
    });

  it("sends the amount in paise", () => {
    expect(req().amount).toBe(14_681_100);
    expect(req().currency).toBe("INR");
  });

  it("STOPS Razorpay from messaging the customer itself", () => {
    /* THE ONE THAT MATTERS MOST HERE. Razorpay will happily SMS and email the link, and then
       the app has sent a customer-facing message that never passed through `sendEmail` — not in
       email_log, not gated by the autonomy dial, not on the lead's timeline. Every other
       outbound message in this codebase goes through one chokepoint; a payment link is the last
       thing that should be the exception. */
    const r = req();
    expect(r.notify.sms).toBe(false);
    expect(r.notify.email).toBe(false);
    expect(r.reminder_enable).toBe(false);
  });

  it("carries the tenant in notes, so the webhook never reads it from the body", () => {
    /* A webhook that trusts a body-supplied tenant_id is a cross-tenant write waiting to
       happen — the same rule the telecall webhook follows. */
    expect(req().notes.tenant_id).toBe("fbb976f1-9090-4f10-9726-0901bd144e42");
    expect(req().notes.quote_id).toBe("Q-ADPL-2026-27-0058");
  });

  it("uses the quote id as the reference, so a duplicate is detectable at Razorpay's end", () => {
    expect(req().reference_id).toBe("Q-ADPL-2026-27-0058");
  });

  it("omits customer fields we do not have rather than sending empty strings", () => {
    const r = paymentLinkRequest({
      quoteId: "Q-1", amountDue: 100, customerName: null, customerEmail: null,
      customerPhone: "+919876543210", sellerName: "ANUTECH", tenantId: "t", expiresOn: null,
    });
    expect(r.customer).toEqual({ contact: "+919876543210" });
  });

  it("does not set an expiry that has already passed", () => {
    /* Razorpay requires at least 15 minutes in the future; an expired quote would otherwise
       produce an API error instead of a readable refusal. */
    const r = paymentLinkRequest({
      quoteId: "Q-1", amountDue: 100, customerName: null, customerEmail: null,
      customerPhone: null, sellerName: "ANUTECH", tenantId: "t", expiresOn: "2020-01-01",
    });
    expect(r.expire_by).toBeUndefined();
  });

  it("truncates a long description rather than letting the API reject it", () => {
    const r = paymentLinkRequest({
      quoteId: "Q-1", amountDue: 100, customerName: null, customerEmail: null,
      customerPhone: null, sellerName: "x".repeat(400), tenantId: "t", expiresOn: null,
    });
    expect(r.description.length).toBeLessThanOrEqual(255);
  });
});

describe("paymentLinkMessage", () => {
  const msg = (mode: "live" | "test") =>
    paymentLinkMessage({
      customerName: "Rahul",
      quoteId: "Q-ADPL-2026-27-0058",
      amountDue: 146_811,
      url: "https://rzp.io/i/abc123",
      mode,
    });

  it("states the amount, the quote and the link", () => {
    const m = msg("live");
    expect(m).toContain("Rs 1,46,811");
    expect(m).toContain("Q-ADPL-2026-27-0058");
    expect(m).toContain("https://rzp.io/i/abc123");
  });

  it("manufactures no urgency", () => {
    /* The volume rate is a published rate card and the quote's own expiry is the only deadline
       there is — the same rule the day-7 cadence step follows. */
    const m = msg("live").toLowerCase();
    expect(m).not.toContain("hurry");
    expect(m).not.toContain("expire");
    expect(m).not.toContain("today only");
    expect(m).not.toContain("confirm your price");
  });

  it("warns loudly on a test link, because it must not reach a customer", () => {
    expect(msg("test")).toContain("TEST MODE");
    expect(msg("test")).toContain("Do not send it to a customer");
    expect(msg("live")).not.toContain("TEST MODE");
  });
});
