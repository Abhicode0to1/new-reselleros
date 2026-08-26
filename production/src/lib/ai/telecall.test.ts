import { describe, it, expect } from "vitest";
import {
  MAX_CALL_ATTEMPTS,
  MIN_HOURS_BETWEEN_CALLS,
  MIN_MEANINGFUL_CALL_SEC,
  authorisedCallFigures,
  classifyCall,
  decideTelecall,
  normaliseIndianPhone,
  statusFromDisposition,
  verifyCallMoney,
  type PostCallSignals,
  type TelecallRequest,
} from "./telecall";

/* A Wednesday, 14:00 IST — inside working hours and inside the week, so nothing in the quiet
   hours rule interferes with the tests that are about something else. 08:30 UTC = 14:00 IST. */
const WEDNESDAY_2PM_IST = new Date("2026-08-26T08:30:00Z");

const OK: TelecallRequest = {
  callType: "lead_qualification",
  rawPhone: "+91 98765 43210",
  at: WEDNESDAY_2PM_IST,
  lastCalledAt: null,
  attemptsSoFar: 0,
  ourNumbers: [],
  doNotCall: false,
  subjectIsOpen: true,
  subjectClosedReason: null,
};

describe("normaliseIndianPhone", () => {
  it.each([
    ["+91 98765 43210", "+919876543210"],
    ["98765 43210", "+919876543210"],
    ["09876543210", "+919876543210"],
    ["+919876543210", "+919876543210"],
    ["0091 98765 43210", "+919876543210"],
    ["9876543210", "+919876543210"],
    ["98765-43210", "+919876543210"],
  ])("reads %s as %s", (raw, expected) => {
    expect(normaliseIndianPhone(raw)).toBe(expected);
  });

  it("keeps a non-Indian number that arrived with its own country code", () => {
    expect(normaliseIndianPhone("+1 415 555 2671")).toBe("+14155552671");
  });

  it.each([
    ["", "empty"],
    [null, "null"],
    ["1234567890", "a 10-digit number that starts below the mobile series"],
    ["12345", "too short to be anything"],
    ["+9198765432109876543", "longer than E.164 permits"],
    ["98765 43210 ext 22", "carries an extension"],
    ["not a number", "no digits at all"],
  ])("refuses %s (%s)", (raw, why) => {
    expect(normaliseIndianPhone(raw), `should refuse: ${why}`).toBeNull();
  });

  it("refuses rather than guessing, and that asymmetry is the point", () => {
    /* The two failure modes do not cost the same. Refusing a valid number wastes one lead;
       dialling a wrongly-guessed one plays a sales pitch at a stranger who never contacted us.
       "022 2758 1234" is a Mumbai landline typed without a usable form — nine digits after the
       trunk prefix — and a guess here would connect to a different subscriber. */
    expect(normaliseIndianPhone("022 2758 1234")).toBeNull();
  });
});

describe("decideTelecall", () => {
  it("places the call when nothing blocks it", () => {
    const d = decideTelecall(OK);
    expect(d.place).toBe(true);
    expect(d.phone).toBe("+919876543210");
  });

  it("refuses a do-not-call before anything else, even with no number at all", () => {
    /* Ordering, asserted deliberately. A do-not-call customer whose number is also unreadable
       must produce the do-not-call sentence: fixing the number would not make the call legal,
       and an operator who reads "no phone number recorded" will go and find one. */
    const d = decideTelecall({ ...OK, rawPhone: "junk", doNotCall: true });
    expect(d.place).toBe(false);
    expect(d.reason).toContain("asked not to be called");
  });

  it("refuses when the number cannot be dialled, and says what was recorded", () => {
    const d = decideTelecall({ ...OK, rawPhone: "12345" });
    expect(d.place).toBe(false);
    expect(d.phone).toBeNull();
    expect(d.reason).toContain("12345");
  });

  it("never rings one of our own numbers", () => {
    const d = decideTelecall({ ...OK, ourNumbers: ["098765 43210"] });
    expect(d.place).toBe(false);
    expect(d.reason).toContain("our own numbers");
  });

  it("compares our own numbers in normalised form, not as typed", () => {
    /* The tenant's phone is free text somebody typed into settings; the lead's is free text
       somebody typed into a form. A string compare would let the same subscriber through
       whenever the two were typed differently, which is most of the time. */
    const d = decideTelecall({ ...OK, rawPhone: "+91 98765 43210", ourNumbers: ["9876543210"] });
    expect(d.place).toBe(false);
  });

  it("refuses a closed subject and uses the caller's own reason", () => {
    const d = decideTelecall({
      ...OK,
      subjectIsOpen: false,
      subjectClosedReason: "this subscription is cancelled, so there is nothing to renew",
    });
    expect(d.place).toBe(false);
    expect(d.reason).toContain("cancelled");
  });

  it(`stops after ${MAX_CALL_ATTEMPTS} attempts`, () => {
    const d = decideTelecall({ ...OK, attemptsSoFar: MAX_CALL_ATTEMPTS });
    expect(d.place).toBe(false);
    expect(d.reason).toContain("does not take automated");
  });

  it(`refuses a second call inside ${MIN_HOURS_BETWEEN_CALLS} hours, and says when it may retry`, () => {
    const twoHoursAgo = new Date(WEDNESDAY_2PM_IST.getTime() - 2 * 3_600_000);
    const d = decideTelecall({ ...OK, lastCalledAt: twoHoursAgo });
    expect(d.place).toBe(false);
    expect(d.retryAfter).not.toBeNull();
    expect(d.retryAfter?.getTime()).toBe(twoHoursAgo.getTime() + MIN_HOURS_BETWEEN_CALLS * 3_600_000);
  });

  it("allows the call once the gap has passed", () => {
    const longAgo = new Date(WEDNESDAY_2PM_IST.getTime() - (MIN_HOURS_BETWEEN_CALLS + 1) * 3_600_000);
    expect(decideTelecall({ ...OK, lastCalledAt: longAgo }).place).toBe(true);
  });

  it("does not ring anybody at 22:00 IST", () => {
    // 16:30 UTC = 22:00 IST, same Wednesday.
    const lateWednesday = new Date("2026-08-26T16:30:00Z");
    const d = decideTelecall({ ...OK, at: lateWednesday });
    expect(d.place).toBe(false);
    expect(d.retryAfter).not.toBeNull();
  });

  it("does not ring anybody on a Sunday afternoon", () => {
    // 2026-08-30 is a Sunday. 08:30 UTC = 14:00 IST.
    const sunday = new Date("2026-08-30T08:30:00Z");
    expect(decideTelecall({ ...OK, at: sunday }).place).toBe(false);
  });

  it("uses the SAME quiet-hours rule the rest of the app obeys", () => {
    /* Not a second calling window invented here. If quiet-hours.ts moves its boundary, this
       moves with it — one answer to "when may this business contact a customer" rather than
       two that drift. 13:00 UTC = 18:30 IST (inside), 13:45 UTC = 19:15 IST (outside). */
    expect(decideTelecall({ ...OK, at: new Date("2026-08-26T13:00:00Z") }).place).toBe(true);
    expect(decideTelecall({ ...OK, at: new Date("2026-08-26T13:45:00Z") }).place).toBe(false);
  });
});

describe("statusFromDisposition", () => {
  it.each([
    ["completed", "completed"],
    ["customer-ended-call", "completed"],
    ["no-answer", "no_answer"],
    ["voicemail", "no_answer"],
    ["user_busy", "busy"],
  ] as const)("maps %s to %s", (given, expected) => {
    expect(statusFromDisposition(given)).toBe(expected);
  });

  it("maps a word it does not recognise to failed, NOT to completed", () => {
    /* A vendor renaming a disposition must not silently promote unknown calls to "this
       conversation happened". `failed` is visible and wrong-in-the-safe-direction; `completed`
       would file a call that may never have connected as one that did, and the quote path
       reads that field. */
    expect(statusFromDisposition("some_new_vendor_word")).toBe("failed");
  });
});

const CONNECTED: PostCallSignals = {
  disposition: "completed",
  durationSec: 120,
  transcript: "",
  summary: "",
  customerAskedForQuote: false,
  customerAskedForCallback: false,
  customerConfirmedRenewal: false,
  customerNotInterested: false,
  seatsDiscussed: null,
};

describe("classifyCall", () => {
  it("concludes nothing from a call that never connected", () => {
    const c = classifyCall({ ...CONNECTED, disposition: "no-answer" }, "lead_qualification");
    expect(c.status).toBe("no_answer");
    expect(c.action).toBe("none");
  });

  it(`concludes nothing from a call shorter than ${MIN_MEANINGFUL_CALL_SEC}s`, () => {
    /* A "completed" six-second call is a wrong number hanging up or a voicemail beep. Quoting
       off that would email a price to somebody who never spoke to us. */
    const c = classifyCall(
      { ...CONNECTED, durationSec: 6, customerAskedForQuote: true, seatsDiscussed: 12 },
      "lead_qualification",
    );
    expect(c.action).toBe("none");
  });

  it("puts 'not interested' AHEAD of 'asked for a quote'", () => {
    /* The order is the assertion. A customer who triggered both signals said no LAST, and
       quoting somebody who declined is the most damaging thing this feature can do unattended. */
    const c = classifyCall(
      { ...CONNECTED, customerAskedForQuote: true, customerNotInterested: true, seatsDiscussed: 12 },
      "lead_qualification",
    );
    expect(c.action).toBe("not_interested");
  });

  it("quotes when they asked and the seat count is known", () => {
    const c = classifyCall(
      { ...CONNECTED, customerAskedForQuote: true, seatsDiscussed: 12 },
      "lead_qualification",
    );
    expect(c.action).toBe("quote_requested");
    expect(c.detail).toContain("12 seats");
  });

  it("hands over when they asked for a quote but never said how many seats", () => {
    /* The call is over, so there is no way to ask. A person rings back in thirty seconds,
       which is cheaper than a quotation for the wrong number of seats. */
    const c = classifyCall({ ...CONNECTED, customerAskedForQuote: true }, "lead_qualification");
    expect(c.action).toBe("handed_to_human");
    expect(c.handoverReason).toContain("never said how many seats");
  });

  it("records a confirmed renewal only on a renewal call", () => {
    const renewal = classifyCall({ ...CONNECTED, customerConfirmedRenewal: true }, "renewal_reminder");
    expect(renewal.action).toBe("renewal_confirmed");

    const qualification = classifyCall(
      { ...CONNECTED, customerConfirmedRenewal: true },
      "lead_qualification",
    );
    expect(qualification.action).toBe("none");
  });
});

describe("authorisedCallFigures", () => {
  const CATALOGUE = [
    { sku: "GW-STD", name: "Google Workspace Business Standard", vendor: "google",
      msrpPerSeatPerYear: 10368, wholesalePerSeatPerYear: 7440, monthlyFlexPerSeatPerMonth: null },
    { sku: "GW-STR", name: "Google Workspace Business Starter", vendor: "google",
      msrpPerSeatPerYear: 3240, wholesalePerSeatPerYear: 1320, monthlyFlexPerSeatPerMonth: null },
  ];

  it("authorises the per-seat rates and anything the app computed itself", () => {
    expect(authorisedCallFigures(CATALOGUE, [24500])).toEqual(
      expect.arrayContaining([10368, 3240, 24500]),
    );
  });

  it("never authorises a total, because the agent is never given arithmetic", () => {
    /* 12 × 10,368 = 124,416. That figure is legitimate on a QUOTE, computed by the app — and
       it is not on this list, because nothing on a call may state it. A model that multiplies
       is a model that can multiply wrongly, out loud, irreversibly. */
    expect(authorisedCallFigures(CATALOGUE)).not.toContain(124416);
  });

  it("never authorises the cost we pay the vendor", () => {
    expect(authorisedCallFigures(CATALOGUE)).not.toContain(7440);
  });
});

describe("verifyCallMoney", () => {
  it("passes a transcript that only quotes authorised rates", () => {
    const v = verifyCallMoney("It is Rs 10,368 per seat per year.", [10368]);
    expect(v.ok).toBe(true);
    expect(v.handoverReason).toBeNull();
  });

  it("catches the total the agent was told not to compute", () => {
    const v = verifyCallMoney(
      "That comes to Rs 1,24,416 for your twelve seats.",
      [10368],
    );
    expect(v.ok).toBe(false);
    expect(v.handoverReason).toContain("not on");
  });

  it("catches a bare four-figure number with no currency marker", () => {
    /* On a sales call almost any four-figure bare number is money, and speech-to-text often
       drops the currency word entirely. A false flag costs one glance at a transcript; a miss
       costs a wrong price already spoken. */
    const v = verifyCallMoney("I can do it for 7500 per seat.", [10368]);
    expect(v.ok).toBe(false);
  });

  it("is strict when nothing was authorised", () => {
    /* An empty authorised list is what a row written before the field existed looks like, and
       what a failed catalogue read looks like. Both should make the check MAXIMALLY strict
       rather than silently permissive — a guard that opens when it loses its reference is not
       a guard. */
    expect(verifyCallMoney("It is Rs 10,368 per seat per year.", []).ok).toBe(false);
  });
});
