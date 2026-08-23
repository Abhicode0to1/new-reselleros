import { describe, it, expect } from "vitest";
import { extractEntities, foundCount, type CatalogueEntry } from "./extract";

const CATALOGUE: CatalogueEntry[] = [
  { id: "GW-STR", name: "Google Workspace Business Starter" },
  { id: "GW-STD", name: "Google Workspace Business Standard" },
  { id: "MS-BAS", name: "Microsoft 365 Business Basic" },
  { id: "ZO-STD", name: "Zoho Workplace Standard" },
];

const run = (over: Partial<Parameters<typeof extractEntities>[0]> = {}) => extractEntities({
  fromName:  "Sujay Rao",
  fromEmail: "sujay@sahakarglobal.com",
  subject:   "Quote for Google Workspace Business Starter",
  body:      "Hello,\n\nWe need 14 seats before August. Call me on +91 98765 43210.\n\nRegards,\nSujay Rao",
  catalogue: CATALOGUE,
  ...over,
});

describe("the ordinary enquiry", () => {
  it("reads all five", () => {
    const e = run();
    expect(e.name.value).toBe("Sujay Rao");
    expect(e.email.value).toBe("sujay@sahakarglobal.com");
    expect(e.phone.value).toBe("9876543210");
    expect(e.seats.value).toBe(14);
    expect(e.product.value?.id).toBe("GW-STR");
    expect(foundCount(e)).toBe(5);
  });

  it("says where each value came from", () => {
    /* A rep signs the quote, so they have to be able to check the value against the
       text it was read from. */
    const e = run();
    expect(e.seats.source).toMatch(/14 seats/i);
    expect(e.phone.source).toMatch(/98765/);
    expect(e.product.source).toBe("Google Workspace Business Starter");
  });
});

describe("nothing is invented", () => {
  it("returns null for what is not there instead of guessing", () => {
    /* These values pre-fill a lead and a quote. A guessed seat count becomes a
       price; a guessed phone number becomes a WhatsApp to a stranger. A blank field
       costs ten seconds of typing. */
    const e = run({
      fromName: null, fromEmail: null,
      subject: "Hello", body: "Please call me back.", catalogue: [],
    });
    expect(e.name.value).toBeNull();
    expect(e.email.value).toBeNull();
    expect(e.phone.value).toBeNull();
    expect(e.seats.value).toBeNull();
    expect(e.product.value).toBeNull();
    expect(foundCount(e)).toBe(0);
  });

  it("a null value carries a null source too", () => {
    const e = run({ body: "Nothing useful here.", subject: "", catalogue: [] });
    expect(e.seats.source).toBeNull();
    expect(e.product.source).toBeNull();
  });
});

describe("seats — a number only counts next to a seat word", () => {
  it.each([
    ["We need 14 seats",              14],
    ["25 users please",               25],
    ["please add 8 licences",          8],
    ["120 mailboxes",                120],
    ["quote for 3 accounts",           3],
  ])("reads %s", (body, expected) => {
    expect(run({ body, subject: "", catalogue: [] }).seats.value).toBe(expected);
  });

  it("does NOT read a date as a seat count", () => {
    /* "14 August" is a number in an enquiry and is not a quantity. */
    expect(run({ body: "We want to start by 14 August.", subject: "", catalogue: [] }).seats.value).toBeNull();
  });

  it("does NOT read a rupee amount as a seat count", () => {
    expect(run({ body: "Our budget is 24,000 for the year.", subject: "", catalogue: [] }).seats.value).toBeNull();
  });

  it("refuses zero and absurd counts", () => {
    expect(run({ body: "0 seats", subject: "", catalogue: [] }).seats.value).toBeNull();
    expect(run({ body: "99999 seats", subject: "", catalogue: [] }).seats.value).toBeNull();
  });
});

describe("phone — Indian mobiles, and nothing that merely looks like one", () => {
  it.each([
    "Call me on +91 98765 43210.",
    "Call me on 09876543210.",
    "Reach me: 9876543210",
    "phone +919876543210",
    "mobile 98765-43210",
  ])("reads %s", (body) => {
    expect(run({ body, subject: "", catalogue: [] }).phone.value).toBe("9876543210");
  });

  it("does NOT pull a mobile out of a GSTIN", () => {
    /* A GSTIN is a long alphanumeric run with valid-looking digits inside it. */
    expect(run({ body: "Our GSTIN is 07ABDCA0298H1ZP.", subject: "", catalogue: [] }).phone.value).toBeNull();
  });

  it("does NOT pull one out of a longer digit run", () => {
    expect(run({ body: "Order reference 1234598765432100 attached.", subject: "", catalogue: [] }).phone.value).toBeNull();
  });

  it("rejects a ten-digit number that cannot be an Indian mobile", () => {
    /* Indian mobiles start 6-9. A landline-style or reference number does not. */
    expect(run({ body: "Ref 1234567890", subject: "", catalogue: [] }).phone.value).toBeNull();
  });
});

describe("product — matched against the tenant's own catalogue", () => {
  it("prefers the LONGEST matching name", () => {
    /* "Google Workspace Business Standard" contains "Google Workspace Business
       Starter"'s prefix. Matching the shorter one quotes the wrong plan at the
       wrong price. */
    const e = run({
      subject: "", body: "We want Google Workspace Business Standard for the team.",
    });
    expect(e.product.value?.id).toBe("GW-STD");
  });

  it("does not turn a vendor name into a SKU", () => {
    /* "We use Google" names a company, not a plan. */
    const e = run({ subject: "", body: "We use Google today and want to switch." });
    expect(e.product.value).toBeNull();
  });

  it("finds nothing when the catalogue is empty, rather than inventing a plan", () => {
    const e = run({ catalogue: [] });
    expect(e.product.value).toBeNull();
  });
});

describe("name", () => {
  it("prefers the sender name the mail server recorded", () => {
    expect(run().name.source).toMatch(/sender name/);
  });

  it("falls back to a sign-off when the header has none", () => {
    const e = run({
      fromName: null,
      body: "Hi,\n\nPlease send a quote.\n\nRegards,\nDeepak Sharma",
    });
    expect(e.name.value).toBe("Deepak Sharma");
  });

  it("does not accept an address or a role word as a name", () => {
    expect(run({ fromName: "sales@anutech.in", body: "no sign off" }).name.value).toBeNull();
    expect(run({ fromName: null, body: "Hi,\n\nquote please\n\nRegards,\nSales" }).name.value).toBeNull();
  });

  it("does not accept a line with digits in it", () => {
    /* Sign-offs are commonly followed by a phone number, not a name. */
    expect(run({ fromName: null, body: "Hi,\n\nquote\n\nRegards,\n+91 98765 43210" }).name.value).toBeNull();
  });
});

describe("email", () => {
  it("prefers the address the mail arrived from", () => {
    const e = run({ body: "Write to me at other@elsewhere.com instead." });
    expect(e.email.value).toBe("sujay@sahakarglobal.com");
  });

  it("falls back to one in the body when the header has none", () => {
    const e = run({ fromEmail: null, body: "Write to me at other@elsewhere.com." });
    expect(e.email.value).toBe("other@elsewhere.com");
  });
});

describe("the subject is searched too", () => {
  it("reads a seat count out of the subject line", () => {
    /* "Quote for 20 seats" carries the whole enquiry often enough to be worth
       looking at before the body's small print. */
    const e = run({ subject: "Quote for 20 seats", body: "See attached.", catalogue: [] });
    expect(e.seats.value).toBe(20);
  });
});

/**
 * ─── THE WORDS AN INDIAN RESELLER'S CUSTOMER ACTUALLY USES ──────────────────
 * The live enquiry — "mujhe 20 email google workspace standard chahiye. iske liye mujhe
 * quote bhej do" — reported SEATS: not found. The quote button then carried no seat count,
 * and whoever built that quote typed a number from memory onto a priced document.
 *
 * Nobody in this market writes "20 seats".
 */
describe("Hinglish and Indian-English seat counts", () => {
  const seats = (body: string) => run({ body, subject: "", catalogue: [] }).seats.value;

  it("reads the LIVE enquiry that failed", () => {
    expect(seats("mujhe 20 email google workspace standard chahiye. iske liye mujhe quote bhej do"))
      .toBe(20);
  });

  it.each([
    ["mujhe 20 email chahiye",            20],
    ["20 emails chahiye",                 20],
    ["mujhe 20 email id chahiye",         20],
    ["we need 50 IDs",                    50],
    ["25 id bana do",                     25],
    ["10 mail id chahiye",                10],
    ["hamare 30 log hain",                30],
    ["12 bande ke liye chahiye",          12],
    ["8 karmchari ke liye",                8],
    ["kindly quote for 15 mailbox",       15],
  ])("reads %j as %i", (body, expected) => {
    expect(seats(body)).toBe(expected);
  });

  it("still reads the textbook phrasings", () => {
    expect(seats("We need 14 seats")).toBe(14);
    expect(seats("40 users please")).toBe(40);
    expect(seats("Please add 5 licenses")).toBe(5);
  });

  it("shows the SOURCE text, so the rep can check before it becomes a price", () => {
    const e = run({ body: "mujhe 20 email chahiye", subject: "", catalogue: [] });
    expect(e.seats.source).toMatch(/20 email/i);
  });
});

/**
 * ─── THE COST OF ACCEPTING "EMAIL" AS A UNIT, AND THE GUARD ─────────────────
 * "I sent you 20 emails" is a complaint about unanswered mail, not an order for twenty
 * mailboxes. Without the guard it becomes a 20-seat quote.
 */
describe("a count of MESSAGES is not a count of seats", () => {
  const seats = (body: string) => run({ body, subject: "", catalogue: [] }).seats.value;

  it.each([
    "I sent you 20 emails last week",
    "we sent 5 mails and got no reply",
    "I have received 12 emails from your team",
    "got 3 emails about this",
    "already forwarded 4 mails",
    "I attached 2 emails for reference",
  ])("ignores %j", (body) => {
    expect(seats(body)).toBeNull();
  });

  it("still reads a real request in the SAME message", () => {
    /* The complaint and the order often arrive together. */
    expect(seats("I sent you 3 emails already. Anyway, mujhe 20 email chahiye."))
      .toBe(20);
  });
});

describe("the old false positives stay excluded", () => {
  const seats = (body: string) => run({ body, subject: "", catalogue: [] }).seats.value;

  it("does not read a date as a quantity", () => {
    expect(seats("We want to start by 14 August.")).toBeNull();
  });

  it("does not read money as a quantity", () => {
    expect(seats("Our budget is 24,000 for the year.")).toBeNull();
  });

  it("does not read a bare number", () => {
    expect(seats("Please call me about 20 of these")).toBeNull();
  });
});

/**
 * ─── STEP 2 IS A CONSEQUENCE OF STEP 1, NOT SEPARATE WORK ───────────────────
 * quoteHref() already passes `seats` when the extractor found one — it just never found
 * one on a Hinglish enquiry, so the button carried nothing and the operator typed a
 * number from memory onto a priced document.
 *
 * These pin the contract the quote link depends on: what the panel shows is exactly what
 * the button sends, and a field that was not found stays absent rather than going as zero.
 */
describe("what the panel shows is what the quote button sends", () => {
  const LIVE = "mujhe 20 email google workspace standard chahiye. iske liye mujhe quote bhej do";

  it("finds seats AND product on the live enquiry", () => {
    const e = run({
      body: LIVE, subject: "", fromName: "Pardeep Sharma",
      fromEmail: "pardeep@exceltechnologies.in",
      catalogue: [{ id: "gws-std", name: "Google Workspace Standard" }],
    });
    expect(e.seats.value).toBe(20);
    expect(e.product.value?.name).toBe("Google Workspace Standard");
    expect(e.name.value).toBe("Pardeep Sharma");
    expect(e.email.value).toBe("pardeep@exceltechnologies.in");
  });

  it("raises the found-count the panel prints", () => {
    /* It read "DETAILS FOUND · 3 OF 5" while seats were missing. */
    const e = run({
      body: LIVE, subject: "", fromName: "Pardeep Sharma",
      fromEmail: "pardeep@exceltechnologies.in",
      catalogue: [{ id: "gws-std", name: "Google Workspace Standard" }],
    });
    expect(foundCount(e)).toBe(4);
  });

  it("leaves a field NULL when it is absent, so nothing is sent as a guess", () => {
    /* An empty `seats=` in the URL lands in the builder as a value somebody has to notice
       and clear. A guessed seat count becomes a price on a signed quote. */
    const e = run({ body: "please send your rate card", subject: "", catalogue: [] });
    expect(e.seats.value).toBeNull();
    expect(e.product.value).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   The product name standing between the number and the seat word.

   Measured on 23 Aug 2026, tracing whether "50 Google Workspace Business Starter"
   asked for by email would reach a quote: it did not, because the seat count came back
   null. Not an exotic phrasing — the most natural way to ask, and the one Pardeep used.

   The strict regex still runs first and this only fills a null, so the negatives below
   are as much the point as the positives: a second pass that turned "₹270 per user" into
   a 270-seat order would be worse than the gap it was written to close.
   ───────────────────────────────────────────────────────────────────────────── */
describe("seats — the unit is separated from the number by a product name", () => {
  const seats = (body: string) => run({ body, subject: "", catalogue: [] }).seats.value;
  const source = (body: string) => run({ body, subject: "", catalogue: [] }).seats.source;

  it.each([
    ["I need a quotation for 50 Google Workspace Business Starter users.", 50],
    ["Please quote 20 Microsoft 365 Business Premium licenses.",           20],
    ["Kindly send rates for 8 Zoho Mail Lite mailboxes.",                   8],
    ["30 Google Workspace Business Standard email id chahiye.",            30],
  ])("reads %j", (body, expected) => {
    expect(seats(body)).toBe(expected);
  });

  it("keeps the whole span as the source, product name included", () => {
    /* A rep checking "50" has to be able to see it was read from the sentence and not
       from a price line four paragraphs away. */
    expect(source("quotation for 50 Google Workspace Business Starter users"))
      .toMatch(/50 Google Workspace Business Starter users/i);
  });
});

describe("the gapped pass must not turn money or time into seats", () => {
  const seats = (body: string) => run({ body, subject: "", catalogue: [] }).seats.value;

  it.each([
    "Our price is 270 per user per month.",
    "It works out to 270 rupees per mailbox.",
    "We can offer 15 percent discount for users on annual billing.",
    "The rate is 199 monthly per licence.",
    "GST is 18 percent on all accounts.",
  ])("refuses %j", (body) => {
    expect(seats(body)).toBeNull();
  });

  it("still prefers the adjacent number when both could match", () => {
    /* THE REASON THIS IS A SECOND PASS. One widened regex would let `exec` return the
       FIRST match — 12 — because "months" is not a seat unit and "for 30" is just gap.
       Strict-first keeps the right answer. */
    expect(seats("Billing for 12 months for 30 users.")).toBe(30);
  });

  it("does not let a message count through the second door", () => {
    /* The strict pass refuses "I sent you 3 emails". A gapped pass without the same
       lookbehind would accept "3 long detailed emails" as an order. */
    expect(seats("I sent you 3 long detailed emails last week.")).toBeNull();
  });

  it("refuses a gap containing a digit", () => {
    expect(seats("Ref 2026 invoice 14 users")).toBe(14);
  });
});

describe("a number inside a product name is not a seat count", () => {
  /* The tenant catalogue IS the authority for what is a name. With no catalogue nothing is
     known and nothing is rejected — the webhook passes the real one. */
  const CAT = [
    { id: "M365-BP", name: "Microsoft 365 Business Premium" },
    { id: "M365-BB", name: "Microsoft 365 Business Basic" },
    { id: "M365",    name: "Microsoft 365" },
  ];
  const withCat = (body: string) => run({ body, subject: "", catalogue: CAT }).seats.value;

  it("does not read 365 out of Microsoft 365", () => {
    /* The FIRST version of the gapped pass returned 365 for "quote 20 Microsoft 365
       Business Premium licenses" — `exec` skipped the 20 and matched the number inside the
       product name. "accounts" and "licenses" are seat units, so a product name with a
       number in it lands right next to one. Microsoft 365 is half of what gets quoted in
       this market; this is not an edge case. */
    expect(withCat("We already use Microsoft 365 accounts here.")).toBeNull();
    expect(withCat("Please quote 20 Microsoft 365 Business Premium licenses.")).toBe(20);
  });

  it("reads the introduced number, not the one in the name", () => {
    expect(withCat("need 12 Microsoft 365 Business Basic mailboxes")).toBe(12);
  });

  it("hands over to the gapped pass when the name-number was a false lead", () => {
    /* "we use Microsoft 365 accounts AND need 20 more mailboxes" — the strict pass matches
       365 first, that gets rejected as part of a name, and the real count still has to be
       found rather than the whole sentence written off. */
    expect(withCat("We use Microsoft 365 accounts and need 20 extra mailboxes.")).toBe(20);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Billing term — monthly or annual, and null whenever the sender did not say.

   Added 23 Aug 2026 as the safety switch for auto-sending a quote built from an email.
   A wrong term is not cosmetic: annual bills twelve months at once, so reading "monthly"
   as "annual" multiplies a customer's invoice by twelve. Null is therefore the answer to
   prefer, and most of these cases assert exactly that.
   ───────────────────────────────────────────────────────────────────────────── */
describe("billing term — only when they said it", () => {
  const term = (body: string) => run({ body, subject: "", catalogue: [] }).term.value;

  it.each([
    ["Please quote 50 users on annual billing.",        "annual"],
    ["We want yearly payment for 50 seats.",            "annual"],
    ["Quote for 20 users per year.",                    "annual"],
    ["Rate for 12 months for 30 users?",                "annual"],
    ["What is the price per month for 10 users?",       "monthly"],
    ["We prefer monthly billing.",                      "monthly"],
    ["50 users chahiye, mahina ka kitna padega?",       "monthly"],
  ])("reads %j as %s", (body, expected) => {
    expect(term(body)).toBe(expected);
  });

  it("says nothing when the mail says nothing", () => {
    /* The commonest real case, and the whole reason the field exists. */
    expect(term("I need a quotation for 50 Google Workspace Business Starter users.")).toBeNull();
  });

  it("says nothing when BOTH terms appear", () => {
    /* "What's the price monthly, and yearly?" is a question about both, not a choice of
       one. Taking whichever matched first would turn a comparison into an order — the
       case a plain keyword search gets wrong. */
    expect(term("Can you send the price monthly, and also yearly?")).toBeNull();
    expect(term("Monthly or annual — whichever is cheaper for 50 users.")).toBeNull();
  });

  it("still reads '12 months' as annual, not as both", () => {
    /* It matches the annual AND the monthly pattern at the same offset, because it IS an
       annual commitment written in months. Resolved before the both-matched rule, or every
       mail phrased that way would come back null. */
    expect(term("We will commit for 12 months.")).toBe("annual");
  });

  it("records the words it read, not just the verdict", () => {
    /* A rep checking why a quote went out on an annual term needs the customer's own
       phrase, not a boolean. */
    const e = run({ body: "Please quote on annual billing.", subject: "", catalogue: [] });
    expect(e.term.source).toMatch(/annual/i);
  });
});
