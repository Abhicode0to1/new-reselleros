import { describe, it, expect } from "vitest";
import { isSelfTest, selfTestMarkerMisplaced } from "./self-test";

describe("isSelfTest — deliberate, from us", () => {
  it("accepts a marked subject from one of our own addresses", () => {
    expect(isSelfTest({ senderIsOurs: true, subject: "[selftest] quote for 50 Business Starter, annual" })).toBe(true);
  });

  it("is case-insensitive and tolerates surrounding space", () => {
    expect(isSelfTest({ senderIsOurs: true, subject: "  [SelfTest] 20 users monthly " })).toBe(true);
  });
});

describe("isSelfTest — the accidents it must keep refusing", () => {
  it("refuses an unmarked mail from our own address", () => {
    /* THE ORIGINAL BUG, reported 22 Aug 2026 as "ye lead kyo bani": a forwarded copy of our
       own mail became a lead named "anutech" with no seats and no plan, next to a real one.
       Nothing about this feature may reopen that. */
    expect(isSelfTest({ senderIsOurs: true, subject: "Fwd: enquiry from a customer" })).toBe(false);
  });

  it("refuses a REPLY or FORWARD of a marked thread", () => {
    /* startsWith, not includes. Reply and forward prefixes are precisely the trail an
       accidental resend leaves; reading one as deliberate would put the hole back. */
    expect(isSelfTest({ senderIsOurs: true, subject: "Re: [selftest] quote for 50" })).toBe(false);
    expect(isSelfTest({ senderIsOurs: true, subject: "Fwd: [selftest] quote for 50" })).toBe(false);
  });

  it("refuses the marker mid-subject", () => {
    expect(isSelfTest({ senderIsOurs: true, subject: "quote please [selftest]" })).toBe(false);
  });

  it("refuses an OUTSIDE address even with the marker", () => {
    /* A stranger writing "[selftest]" is a customer with an odd subject, and they travel
       the ordinary path. A privileged route through a public webhook for anyone who knows a
       string would be a hole, not a feature — the marker widens what OUR addresses may do
       and nothing else. */
    expect(isSelfTest({ senderIsOurs: false, subject: "[selftest] give me a lead" })).toBe(false);
  });

  it("refuses an empty or missing subject", () => {
    expect(isSelfTest({ senderIsOurs: true, subject: "" })).toBe(false);
    expect(isSelfTest({ senderIsOurs: true, subject: null })).toBe(false);
  });

  it("does not match the auto-quote mail this feature exists to test", () => {
    /* The loop that would be the real danger. The quote email's own subject is
       "Your quote Q-… — <tenant>"; if that ever began with the marker, a self-test would
       trigger a send that triggered another self-test. Asserted, not assumed. */
    expect(isSelfTest({ senderIsOurs: true, subject: "Your quote Q-ADPL-2026-27-0007 — ANUTECH DIGITAL PVT LTD" })).toBe(false);
  });
});

describe("selfTestMarkerMisplaced — the deliberate-but-malformed middle case", () => {
  /* Added after the live run on 23 Aug 2026. A forwarded self-test arrived as
     "Fwd: [selftest] …", was refused correctly, and the log said only "sent from one of our
     own addresses" — true, and silent about a marker having been typed at all. Diagnostic
     only: it changes no decision. */

  it.each([
    "Fwd: [selftest] Quotation for 50 Google Workspace Business Starter users",
    "Re: [selftest] quote for 50",
    "quote please [selftest]",
  ])("spots the marker in the wrong place: %j", (subject) => {
    expect(selfTestMarkerMisplaced(subject)).toBe(true);
  });

  it("is false for a correctly placed marker", () => {
    /* Otherwise every working self-test would log a warning telling the operator it did not
       work. */
    expect(selfTestMarkerMisplaced("[selftest] quote for 50")).toBe(false);
  });

  it.each(["Need 20 mailboxes", "", null])("is false when there is no marker at all: %j", (subject) => {
    expect(selfTestMarkerMisplaced(subject)).toBe(false);
  });

  it("does not change what isSelfTest decides", () => {
    /* The pairing that matters: misplaced is reported AND still refused. Relaxing the
       position rule would let our own AI-written "Re: [selftest] …" reply back in and close
       a loop, so these two must never be confused for each other. */
    const subject = "Fwd: [selftest] quote for 50";
    expect(selfTestMarkerMisplaced(subject)).toBe(true);
    expect(isSelfTest({ senderIsOurs: true, subject })).toBe(false);
  });
});
