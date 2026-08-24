import { describe, it, expect } from "vitest";
import { decideAutoReply, type AutoReplyInput } from "./auto-reply";

/** Everything true, nothing promised — the one shape that sends. */
const ok: AutoReplyInput = {
  senderIsOurs: false,
  theyWroteLast: true,
  alreadyReplied: false,
  humanIsHandlingIt: false,
  draftIsForThisLead: true,
  draft: {
    subject: "Re: Google Workspace enquiry",
    message: "Thanks for writing in. Which plan did you have in mind, and how many users?",
  },
};

describe("the one case that sends", () => {
  it("sends when they wrote last, nobody has it, and nothing is promised", () => {
    const d = decideAutoReply(ok);
    expect(d.send).toBe(true);
    expect(d.reason).toMatch(/promises nothing/);
  });
});

describe("the refusal that would be a loop", () => {
  it("never answers one of our own addresses, and checks it first", () => {
    /* Worst failure available here: a reply to ourselves lands back in a customer-facing
       mailbox. Checked before anything else so it cannot be reached past another rule. */
    const d = decideAutoReply({ ...ok, senderIsOurs: true, theyWroteLast: false, alreadyReplied: true });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.reason).toMatch(/our own addresses/);
  });
});

describe("the refusals that fail quietly", () => {
  it("does not answer when OUR message is newest", () => {
    /* Nobody is waiting. A reply here is us talking to ourselves in front of a customer. */
    const d = decideAutoReply({ ...ok, theyWroteLast: false });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.reason).toMatch(/nobody is waiting/);
  });

  it("does not answer the same message twice", () => {
    /* The webhook's messageId idempotency is the WEBHOOK's guarantee, not this decision's. A
       manual replay or a second automated path added later would both arrive here with the
       message already answered — and two replies to one email means the customer has to ask
       which one counts. */
    const d = decideAutoReply({ ...ok, alreadyReplied: true });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.reason).toMatch(/already been answered/);
  });

  it("stands down when a person has picked the thread up", () => {
    /* A machine chiming in over a colleague mid-conversation is worse than silence. */
    const d = decideAutoReply({ ...ok, humanIsHandlingIt: true });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.reason).toMatch(/picked this thread up/);
  });

  it.each([null, { subject: "Re: hi", message: "" }, { subject: "", message: "   " }])(
    "does not send %j",
    (draft) => {
      const d = decideAutoReply({ ...ok, draft: draft as AutoReplyInput["draft"] });
      expect(d.send).toBe(false);
    },
  );

  it("holds a truncated generation rather than sending a stub", () => {
    /* A two-word reply reads as a snub. */
    const d = decideAutoReply({ ...ok, draft: { subject: "Re: hi", message: "Thanks, noted." } });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.reason).toMatch(/too short to be a real reply/);
  });

  it("holds a generic template", () => {
    /* Fine for a person to adapt, wrong to send unattended — it is not an answer to what
       they actually asked. This fires when the drafter fell back because Gemini was
       unreachable, which looks like a successful draft from the outside. */
    const d = decideAutoReply({ ...ok, draftIsForThisLead: false });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.reason).toMatch(/generic template/);
  });
});

describe("the promise rule", () => {
  it("holds a draft that names a price", () => {
    const d = decideAutoReply({
      ...ok,
      draft: { subject: "Re: enquiry", message: "Thanks. For 50 users the total works out to ₹1,62,000 including GST." },
    });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.findings?.some((f) => f.kind === "money")).toBe(true);
  });

  it("holds a draft that names a deadline", () => {
    const d = decideAutoReply({
      ...ok,
      draft: { subject: "Re: enquiry", message: "Thanks for writing in — I will have the full quotation with you by Friday." },
    });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.findings?.some((f) => f.kind === "date")).toBe(true);
  });

  it("checks the SUBJECT too, not only the body", () => {
    /* A promise in a subject line is the part they read before opening anything. */
    const d = decideAutoReply({
      ...ok,
      draft: { subject: "Your 15% discount on Google Workspace", message: "Thanks for writing in. Which plan did you have in mind?" },
    });
    expect(d.send).toBe(false);
  });

  it("passes the findings through, so the log can show what was spotted", () => {
    const d = decideAutoReply({
      ...ok,
      draft: { subject: "Re: enquiry", message: "Thanks — I guarantee we can migrate your mailboxes without any downtime at all." },
    });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.findings?.[0].matched.toLowerCase()).toBe("guarantee");
  });
});

describe("order of refusals", () => {
  it("reports the loop before the promise", () => {
    /* Two things wrong at once should report the one that matters. Sending to ourselves is a
       loop; a promise is a wait. */
    const d = decideAutoReply({
      ...ok,
      senderIsOurs: true,
      draft: { subject: "Re", message: "The total is ₹50,000 and I guarantee delivery by Friday." },
    });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.reason).toMatch(/our own addresses/);
  });

  it("reports the promise last, once everything mechanical is fine", () => {
    /* So the operator-facing message is about the DECISION they can make — send it as
       written or edit it — and not about plumbing they cannot. */
    const d = decideAutoReply({
      ...ok,
      draft: { subject: "Re: enquiry", message: "Thanks for writing in. I can offer a discount on fifty seats if that helps." },
    });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.reason).not.toMatch(/nobody is waiting|already been answered|template|too short/);
    expect(d.reason).toMatch(/discount/);
  });
});

describe("the operator's own self-test", () => {
  /* THE OVERSIGHT THIS FIXES, found 24 Aug 2026 on the first successful AI draft. The escape
     was added to lib/quotes/auto-send-quote.ts in the same sitting and NOT here, so a marked
     self-test exercised the whole chain except the one step it existed to prove: the draft
     came back `held` reading "the sender is one of our own addresses" instead of "replies are
     set to hold for this workspace". Right outcome, wrong reason, and the wrong reason is what
     stops somebody trusting the next result. */

  it("lets a marked self-test past the own-address rule", () => {
    const d = decideAutoReply({ ...ok, senderIsOurs: true, isSelfTest: true });
    expect(d.send).toBe(true);
  });

  it("still refuses our own address when it is NOT a marked self-test", () => {
    const d = decideAutoReply({ ...ok, senderIsOurs: true, isSelfTest: false });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.reason).toMatch(/our own addresses/);
  });

  it("behaves as false when the flag is absent", () => {
    /* Every existing caller omitted it before today. Absent must mean "not a self-test", or
       adding the parameter would have quietly opened the loop for the whole pipeline. */
    const d = decideAutoReply({ ...ok, senderIsOurs: true });
    expect(d.send).toBe(false);
  });

  it("does NOT exempt a self-test from the promise rule", () => {
    /* The marker buys passage through one rule. A self-test that could send a price would
       prove a behaviour the real path does not have — worse than not testing it. */
    const d = decideAutoReply({
      ...ok,
      senderIsOurs: true,
      isSelfTest: true,
      draft: { subject: "Re: enquiry", message: "Thanks — the total for fifty seats is ₹1,62,000 including GST." },
    });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.findings?.some((f) => f.kind === "money")).toBe(true);
  });

  it("does NOT exempt a self-test from the other mechanical checks", () => {
    expect(decideAutoReply({ ...ok, senderIsOurs: true, isSelfTest: true, theyWroteLast: false }).send).toBe(false);
    expect(decideAutoReply({ ...ok, senderIsOurs: true, isSelfTest: true, alreadyReplied: true }).send).toBe(false);
    expect(decideAutoReply({ ...ok, senderIsOurs: true, isSelfTest: true, humanIsHandlingIt: true }).send).toBe(false);
    expect(decideAutoReply({ ...ok, senderIsOurs: true, isSelfTest: true, draftIsForThisLead: false }).send).toBe(false);
  });
});
