import { describe, it, expect } from "vitest";
import { decideDisposition } from "./disposition";

describe("decideDisposition", () => {
  it("files a reply from an existing lead on that lead, whatever the classifier says", () => {
    /* THE REPORTED BUG. The route asked "is this an enquiry?" before "do we know this
       person?", so a mid-thread reply — "actually I need 20 users of Standard, not 50 of
       Starter" — was correctly judged "not a new enquiry" and filed under Spam / System.
       It was the most important message in the thread. */
    const d = decideDisposition({ openLeadId: "L-MT4HUR6P", isEnquiry: false });
    expect(d.action).toBe("append");
    expect(d.action === "append" && d.leadId).toBe("L-MT4HUR6P");
  });

  it("never skips a message from someone we have an open lead with", () => {
    /* Swept across every classifier value, because the whole point is that this input
       is not consulted when a conversation already exists. */
    for (const isEnquiry of [true, false, null, undefined]) {
      const d = decideDisposition({ openLeadId: "L-1", isEnquiry });
      expect(d.action, `isEnquiry=${String(isEnquiry)}`).toBe("append");
    }
  });

  it("creates a lead for a genuine enquiry from a stranger", () => {
    expect(decideDisposition({ openLeadId: null, isEnquiry: true }).action).toBe("create");
  });

  it("skips non-sales mail from a stranger", () => {
    /* The case the classifier is actually for — a newsletter, a security alert, a
       receipt. This is what keeps the Inbox worth opening. */
    const d = decideDisposition({ openLeadId: null, isEnquiry: false });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/no open conversation/i);
  });

  it("treats an ABSENT classification as 'let the operator see it', not as spam", () => {
    /* isEnquiry: null means Gemini did not run — no key, a timeout, the breaker open.
       An absence is not a verdict. Filing mail as spam because the AI was down is how a
       real customer's first email disappears during an outage. */
    for (const missing of [null, undefined]) {
      const d = decideDisposition({ openLeadId: null, isEnquiry: missing });
      expect(d.action, String(missing)).toBe("create");
      expect(d.reason).toMatch(/did not run/i);
    }
  });

  it("treats a blank or whitespace lead id as no lead", () => {
    /* A "" from a maybeSingle() miss must not look like a match and produce an append
       against an empty id. */
    expect(decideDisposition({ openLeadId: "", isEnquiry: false }).action).toBe("skip");
    expect(decideDisposition({ openLeadId: "   ", isEnquiry: false }).action).toBe("skip");
  });

  it("always explains itself", () => {
    /* The reason is written into the row's status trail. "Why is this in Spam" was
       unanswerable before, which is why the report took a database query to diagnose. */
    const all = [
      decideDisposition({ openLeadId: "L-1", isEnquiry: false }),
      decideDisposition({ openLeadId: null, isEnquiry: true }),
      decideDisposition({ openLeadId: null, isEnquiry: false }),
      decideDisposition({ openLeadId: null, isEnquiry: null }),
    ];
    for (const d of all) expect(d.reason.length).toBeGreaterThan(20);
  });
});

describe("decideDisposition — our own address is never a customer", () => {
  /* A regression introduced on 23 Aug 2026 and caught by the operator within the hour:
     "ye lead kyo bani". Every reply on a thread arrives twice — once at the
     customer-facing address, once at the address we send FROM, because that address is
     in the thread. Making an absent classification resolve to `create` (so a real first
     email could not vanish during an outage) turned every echo of our own mail into a
     new lead named after our own domain. */

  it("skips mail from our own address even when it looks like an enquiry", () => {
    const d = decideDisposition({ senderIsOurs: true, openLeadId: null, isEnquiry: true });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/our own address/i);
  });

  it("skips it whatever the classifier says, including when it did not run", () => {
    /* isEnquiry: null was the exact path that created the lead. */
    for (const isEnquiry of [true, false, null, undefined]) {
      expect(decideDisposition({ senderIsOurs: true, isEnquiry }).action, String(isEnquiry)).toBe("skip");
    }
  });

  it("does NOT append our own echo onto the open lead either", () => {
    /* Tempting, and wrong: the outgoing message is already recorded as sent
       (status reply_sent), so appending the echo duplicates the thread. */
    const d = decideDisposition({ senderIsOurs: true, openLeadId: "L-MT4HUR6P", isEnquiry: false });
    expect(d.action).toBe("skip");
  });

  it("leaves a genuine customer on the same domain alone", () => {
    /* senderIsOurs is an exact-address decision made by the caller, not a domain guess.
       A customer whose address merely resembles ours must still be handled normally. */
    const d = decideDisposition({ senderIsOurs: false, openLeadId: null, isEnquiry: true });
    expect(d.action).toBe("create");
  });

  it("treats an absent flag as 'not ours', so no caller silently opts out", () => {
    expect(decideDisposition({ openLeadId: null, isEnquiry: true }).action).toBe("create");
  });
});
