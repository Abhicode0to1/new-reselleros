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

describe("Hinglish durations — the hole found on 25 Aug 2026", () => {
  it("catches the sentence a brief asked the agent to write", () => {
    /* THE ONE THAT STARTED IT. "in 2 hours" was already caught; this puts the number first and
       the unit in Hindi, which matched nothing — a duration promise about work whose length
       depends entirely on how many mailboxes there are and how big they are. */
    const p = findPromises("Hum aapke saare emails 2 ghante mein migrate kar denge.");
    expect(p.safe).toBe(false);
    expect(p.findings.map((f) => f.matched).join(" ")).toContain("2 ghante");
  });

  it.each([
    "3 ghanta lagega",
    "2 din mein ho jayega",
    "1 hafte mein setup complete",
    "6 mahine ka plan activate kar denge",
    "we will finish this in 4 hours",
    "migration 2 hours mein complete",
    "done in 3 working days",
  ])("catches %s", (text) => {
    expect(findPromises(text).safe).toBe(false);
  });

  it("does NOT catch a duration that describes somebody else's process", () => {
    /* Caught by an existing support-agent test the moment this rule was broadened, and it was
       right to: "DNS changes can take up to 48 hours to propagate" is a statement about how the
       internet works and an upper BOUND that protects us — the opposite of a deadline we could
       miss. A guard that blocks it would make the honest DNS answer unsendable. */
    expect(findPromises("DNS changes can take up to 48 hours to propagate.").safe).toBe(true);
  });

  it.each([
    "Propagation takes 24 hours in most cases.",
    "Verification can take up to 72 hours at some registrars.",
    "Google's own sync takes 2 days for large mailboxes.",
  ])("leaves %s alone", (text) => {
    expect(findPromises(text).safe).toBe(true);
  });

  it("still allows the vague futures that make a safe reply possible", () => {
    /* The original comment on DATE_RE: "shortly" and "soon" promise nothing anyone can hold a
       stopwatch to, and they are what makes a safe acknowledgement possible at all. */
    expect(findPromises("We will get back to you shortly.").safe).toBe(true);
    expect(findPromises("Someone from the team will call you soon.").safe).toBe(true);
  });
});

/* ══ Minutes and seconds — the hole found 25 Aug 2026 ════════════════════════
   The hour-and-upward patterns came out of a brief about migration, where hours is the natural
   unit. A brief about "instant 10-minute setup" arrived the next day and every one of these came
   back safe. Two briefs, two holes in the same rule, each in whatever unit that brief used. */

describe("a duration in minutes or seconds is still a promise", () => {
  it.each([
    ["We can have your email running in 10 minutes.", "the preposition-first English form"],
    ["10 minute mein setup ho jayega.", "number-first Hinglish"],
    ["Setup in 30 seconds.", "seconds"],
    ["5 min mein ho jayega", "the abbreviated unit"],
    [
      "Our round-the-clock phone support SLA is a 15 minute response.",
      "the SLA figure that slipped through in production shape",
    ],
  ])("catches %s (%s)", (line, why) => {
    /* The last case is the one that had already got past. A draft goes through
       maskAuthorisedSellingPoints BEFORE this runs, which rewrites "24/7" to "round-the-clock"
       because round-the-clock support is an authorised claim — so the only token being caught
       disappeared and the response-time figure went with the mail. Round-the-clock support is
       a promise we keep; a number beside it is a contract nobody signed. */
    expect(findPromises(line).safe, `should catch: ${why}`).toBe(false);
  });

  it.each([
    ["Our minimum order is one seat.", "minimum is not min"],
    ["A second opinion is always welcome.", "a second opinion is not seconds"],
    ["Migration takes 2 days depending on mailbox size.", "'takes' is somebody else's process"],
    ["DNS changes can take up to 48 hours to propagate.", "'up to' is a bound, not a deadline"],
  ])("still lets %s through (%s)", (line, why) => {
    /* Word boundaries are what separate the first two: `\bmin\b` and `\bsec\b` never the bare
       prefixes. The last two are the lookbehinds added the day before, re-asserted here
       because widening the unit list is exactly when they could have been lost. */
    expect(findPromises(line).safe, `should allow: ${why}`).toBe(true);
  });
});

describe("Hindi day-words are the same commitment as the English ones", () => {
  it.each([
    ["Aaj hi chalu kar denge.", "aaj"],
    ["Kal tak ho jayega.", "kal"],
    ["Parson tak kar denge.", "parson"],
    ["Abhi kar dete hain.", "abhi"],
  ])("catches %s", (line) => {
    /* `today`, `tomorrow` and `yesterday` have been unconditional since this rule was written.
       These were safe purely because the list was in English, while the agent writes Hinglish —
       the same shape of gap as the duration units above. */
    expect(findPromises(line).safe).toBe(false);
  });

  it.each([
    ["Abhi tak koi jawaab nahi mila hai.", "'abhi tak' describes the present, it commits to nothing"],
    ["Abhi bhi wahi problem hai.", "'abhi bhi' is 'still'"],
  ])("still lets %s through (%s)", (line, why) => {
    /* The negative lookahead. Without it a complaint about the past reads as a promise about
       the future, and holding a reply over that word would be the guard misfiring on the
       customer's own idiom. */
    expect(findPromises(line).safe, `should allow: ${why}`).toBe(true);
  });
});

/* ══ A duration in the past is a report; "we will take" is not ═══════════════ */

describe("past-tense durations are reports, not promises", () => {
  it.each([
    ["Lasted about 4 minutes.", "the app's own note about a finished call"],
    ["The migration took 3 days for a similar customer.", "the most useful honest timeline answer"],
    ["We spent 2 hours on it.", "past tense, us as the actor, already done"],
    ["The call ran for 10 minutes.", "a length, not a deadline"],
    ["A migration can take 2 days.", "a possibility after a modal"],
    ["It may take 3 working days.", "the same, with 'may'"],
  ])("lets %s through (%s)", (line, why) => {
    /* ─── FOUND BY THIS APP REFUSING ITS OWN NOTE ─────────────────────────────
       `callTurnFor` writes "Lasted about 4 minutes" into the shared transcript, and the guard
       held it. A duration in the past describes something that has already happened, so it
       cannot be a commitment in any reading — and blocking it would make the honest answer
       about a timeline unsendable. */
    expect(findPromises(line).safe, `should allow: ${why}`).toBe(true);
  });

  it.each([
    ["We will take 3 days.", "will + bare take"],
    ["We shall take 2 hours.", "shall + bare take"],
    ["We will take about 3 days.", "'about' must not rescue a commitment"],
  ])("still catches %s (%s)", (line, why) => {
    /* ─── AND THIS WAS A HOLE FROM THE DAY THE RULE WAS WRITTEN ───────────────
       The exemption was spelled `takes?`, which also matches the BARE form — so every "we will
       take N days" was exempt and had been all along. `takes` and `taking` describe a process;
       bare `take` does not. It is now exempt only after a modal ("can take", "may take"), which
       states a possibility rather than a commitment.

       Measured, not reasoned: this sentence came back SAFE before the fix. */
    expect(findPromises(line).safe, `should catch: ${why}`).toBe(false);
  });
});
