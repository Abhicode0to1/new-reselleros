import { describe, it, expect } from "vitest";
import { findPromises } from "./promise-check";

/* ─────────────────────────────────────────────────────────────────────────────
   The gate step 2 rests on: may the app send this reply by itself?

   The SAFE cases below are the feature. If they hold, step 2 is built and never fires, and
   a feature that never fires is worse than an unbuilt one — it reads as done. So they are
   asserted as carefully as the refusals, and they are written in the words a real
   acknowledgement uses rather than in words chosen to pass.
   ───────────────────────────────────────────────────────────────────────────── */

const safe = (t: string) => findPromises(t).safe;

describe("safe to send unattended — this is the feature", () => {
  it.each([
    "Hi Ankit,\n\nThanks for your enquiry — I have it. Which plan did you have in mind?\n\n— ANUTECH",
    "Thanks for writing in. How many users are we setting up?",
    "Got it. Feel free to call me on the number below and we can go through the options.",
    "Noted. I will put a quotation together and send it across shortly.",
    "Thank you for the details. Is there a good time to speak this afternoon or should I call?",
    "Received, thank you. Are you migrating from an existing provider?",
    "Thanks — before I quote, do you need the Business Standard features or is Starter enough?",
  ])("passes %j", (text) => {
    expect(safe(text)).toBe(true);
  });

  it("lets 'feel free' through, because it is the commonest sentence in this context", () => {
    /* THE TRAP. A bare \bfree\b would hold almost every safe reply and the feature would
       look built while never firing. Excluded by phrase, not by dropping the word — see the
       next test. */
    expect(safe("Feel free to reply with any questions.")).toBe(true);
    expect(safe("Please feel free to call.")).toBe(true);
  });

  it("allows a vague future, which is what makes an acknowledgement possible at all", () => {
    /* "shortly" and "soon" promise nothing anyone can hold a stopwatch to. Holding those
       would leave no safe way to say "I am on it". */
    expect(safe("I will send the quotation shortly.")).toBe(true);
    expect(safe("We will come back to you soon.")).toBe(true);
  });
});

describe("money — no figure at all on this path", () => {
  it.each([
    "The total comes to ₹1,62,000 including GST.",
    "It works out to Rs. 3240 per seat per year.",
    "That would be 191160/- all in.",
  ])("holds %j", (text) => {
    expect(safe(text)).toBe(false);
    expect(findPromises(text).findings.some((f) => f.kind === "money")).toBe(true);
  });

  it("is stricter than the human drafter, on purpose", () => {
    /* The operator-facing path allows a figure that IS on the deal, because somebody is
       about to read the sentence around it. Here nobody is: a correct number in a sentence
       the model wrote can still commit us to something the quote does not say — "that price
       includes migration". */
    expect(safe("As quoted, the total is ₹1,62,000.")).toBe(false);
  });

  it("holds a bare percentage even with no currency", () => {
    expect(safe("GST at 18% applies on top.")).toBe(false);
    expect(safe("I can do 10 percent better than that.")).toBe(false);
  });
});

describe("dates and deadlines — a time is a commitment", () => {
  it.each([
    "I will send it by Friday.",
    "You will have the quote tomorrow.",
    "We can set this up within 2 days.",
    "Let me get this to you by EOD.",
    "I will call you next week.",
    "The quote is valid until 25 Aug.",
    "Expect it on 25/08.",
    "Provisioning completes 2026-08-30.",
  ])("holds %j", (text) => {
    expect(safe(text)).toBe(false);
    expect(findPromises(text).findings.some((f) => f.kind === "date")).toBe(true);
  });

  it("holds an innocent 'today' too, and that cost is deliberate", () => {
    /* A rule that tried to tell a commitment from a pleasantry is the widening trap the
       seat-count regex fell into. There the cost was a missing number; here it would be a
       promise nobody checked. So this holds a reply it did not need to — and every hold is
       logged with the matched phrase, so in a week the log says whether this rule is mostly
       catching real deadlines or mostly catching "thanks for writing today". Tighten from
       that data, not from a guess made now. */
    const r = findPromises("Thanks for writing today.");
    expect(r.safe).toBe(false);
    expect(r.findings[0].matched.toLowerCase()).toBe("today");
  });
});

describe("discounts and giveaways", () => {
  it.each([
    "I can offer a small discount on 50 seats.",
    "We will waive the setup fee.",
    "The first month is free.",
    "Migration is free of charge.",
    "I can do 15% off for an annual commitment.",
    "Setup at no cost.",
    "I will give you our best price.",
  ])("holds %j", (text) => {
    expect(safe(text)).toBe(false);
  });

  it("does not fire on 'office' or 'offer' by accident", () => {
    /* Word boundaries, checked rather than assumed — "off" inside "office" would hold every
       reply that mentioned where somebody works. */
    expect(safe("Our office is in Delhi. Which city are you in?")).toBe(true);
  });
});

describe("guarantees — a promise with no number in it", () => {
  it.each([
    "I guarantee this will work with your existing domain.",
    "I can assure you there will be no downtime.",
    "I promise to look into it.",
    "We will make sure the migration is clean.",
    "There is a full refund if you are not happy.",
    "No risk at all.",
  ])("holds %j", (text) => {
    expect(safe(text)).toBe(false);
  });
});

describe("what the operator is told", () => {
  it("quotes the phrase, not just the category", () => {
    /* "held: date" teaches nobody anything. "it says 'by Friday'" tells them whether to send
       it as written. */
    const r = findPromises("I will send the quote by Friday.");
    /* "Friday", not "by Friday" — the weekday IS the match, and quoting exactly what fired
       is more useful than a prettier phrase that hides which rule caught it. My first
       version of this assertion expected the preposition and was simply wrong about the
       function; the function was right. */
    expect(r.reason).toContain("Friday");
    expect(r.findings[0]).toEqual({ kind: "date", matched: "Friday" });
    expect(r.reason).toMatch(/send it yourself/);
  });

  it("counts the rest instead of listing everything", () => {
    const r = findPromises("I will send it by Friday with a 10% discount, total ₹50,000, guaranteed.");
    expect(r.findings.length).toBeGreaterThan(1);
    expect(r.reason).toMatch(/and \d+ more/);
  });

  it("says plainly that nothing was found when nothing was", () => {
    expect(findPromises("Thanks — which plan did you want?").reason)
      .toMatch(/promises nothing/);
  });
});

describe("edge inputs", () => {
  it.each(["", "   ", "\n\n"])("treats %j as safe rather than crashing", (text) => {
    /* An empty draft is not a promise. It is also not something to SEND — that is the
       caller's check, and keeping the two apart stops this function growing a second job. */
    expect(safe(text)).toBe(true);
  });

  it("handles CRLF the same as LF", () => {
    expect(safe("I will send it\r\nby Friday.")).toBe(false);
  });
});
