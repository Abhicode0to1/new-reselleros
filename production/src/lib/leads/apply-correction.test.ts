import { describe, it, expect } from "vitest";
import { planCorrections, correctionDetail, type LeadFacts } from "./apply-correction";
import { extractEntities } from "@/lib/inbound/extract";
import { stripQuoted } from "@/lib/inbound/strip-quoted";

const CATALOGUE = [
  { id: "i-starter",  name: "Google Workspace Business Starter" },
  { id: "i-standard", name: "Google Workspace Business Standard" },
  { id: "i-plus",     name: "Google Workspace Business Plus" },
];

/** The real thread's lead row: what it said, wrongly, after two corrections. */
const LEAD: LeadFacts = { seats: 50, plan: "Google Workspace Business Starter" };

/** The end-to-end path a reply actually takes: strip, extract, plan. */
function planFor(body: string, current: LeadFacts = LEAD) {
  const fresh = stripQuoted(body);
  return planCorrections({
    current,
    freshText: fresh.text,
    extracted: extractEntities({
      fromName: "test", fromEmail: "pardeep@anutech.in",
      subject: "Re: About your inquiry · Test Company",
      body: fresh.text, catalogue: CATALOGUE,
    }),
  });
}

describe("planCorrections — the reported thread", () => {
  const REAL_REPLY = `Hi,

Actually, I need the quotation for 20 users of Google Workspace Business
Standard, not 50 users of Starter. Please adjust that.

On Sat, 22 Aug 2026 at 21:54, <sales@anutech.in> wrote:

> Hi test,
>
> Thank you for your enquiry for 50 users of Google Workspace Business
> Starter. I am preparing the quotation now and will send it across shortly.`;

  it("reads 20 and Standard out of the reply, not 50 and Starter out of our quote", () => {
    /* The one that matters. Both numbers and both product names are in the raw body;
       only the quoted half is ours. Getting this backwards would write 50 into the row
       and cite the customer as the source. */
    const { corrections } = planFor(REAL_REPLY);
    const seats = corrections.find((c) => c.field === "seats");
    const plan  = corrections.find((c) => c.field === "plan");

    expect(seats?.to).toBe("20");
    expect(seats?.from).toBe("50");
    expect(plan?.to).toBe("Google Workspace Business Standard");
    expect(plan?.from).toBe("Google Workspace Business Starter");
  });

  it("quotes the customer's own sentence as the reason for each change", () => {
    const { corrections } = planFor(REAL_REPLY);
    for (const c of corrections) {
      expect(c.source.length).toBeGreaterThan(3);
      /* The source must come from the FRESH half. If it were read from the quoted
         block it would carry our wording. */
      expect(c.source).not.toContain("Thank you for your enquiry");
    }
  });

  it("writes a log line that answers 'says who?'", () => {
    const { corrections } = planFor(REAL_REPLY);
    const line = correctionDetail(corrections.find((c) => c.field === "seats")!);
    expect(line).toContain("Seats: 50 → 20");
    expect(line).toContain("from the customer's reply");
  });
});

describe("planCorrections — every reason it refuses", () => {
  it("does nothing when the reply is only a quoted thread", () => {
    /* A "thanks" top-post, or a bare quote. Must never move the record. */
    const { corrections, skipped } = planFor(
      "On Sat, 22 Aug 2026 at 21:54, <a@b.in> wrote:\n> 50 users of Starter",
    );
    expect(corrections).toEqual([]);
    expect(skipped.every((s) => /no new text/i.test(s.reason))).toBe(true);
  });

  it("does nothing when the customer says nothing about seats or product", () => {
    const { corrections } = planFor("Yes, everything is correct. Please proceed.");
    expect(corrections).toEqual([]);
  });

  it("treats a restated SAME number as confirmation, not a change", () => {
    /* "yes, 50 users" must not log a correction from 50 to 50 — a log full of
       no-op corrections is a log nobody reads. */
    const { corrections } = planFor("Yes please, 50 users of Business Starter.");
    expect(corrections).toEqual([]);
  });

  it("refuses a seat count outside a plausible order", () => {
    /* "we have 250000 employees worldwide" is a fact about the company, not an order,
       and writing it would blow up every figure derived from the row. It is refused
       one layer earlier than expected — the extractor declines it, so the reason reads
       "no seat count stated" rather than "outside the range". Either refusal is correct;
       asserting the outcome rather than which layer caught it. */
    const { corrections, skipped } = planFor("We have 250000 employees worldwide.");
    expect(corrections.find((c) => c.field === "seats")).toBeUndefined();
    expect(skipped.find((x) => x.field === "seats")).toBeDefined();
  });

  it("refuses an implausible count that DOES reach the bounds check", () => {
    /* Belt and braces: the SEATS_MIN/MAX guard must work on its own, not only behind
       whatever the extractor happens to reject. */
    const { corrections } = planFor("Please quote 99999 users of Business Standard.");
    expect(corrections.find((c) => c.field === "seats")).toBeUndefined();
  });

  it("never blanks a value the customer did not mention", () => {
    /* Silence is not an instruction to clear the field. */
    const { corrections } = planFor("Sounds good, go ahead.");
    expect(corrections).toEqual([]);
  });

  it("does not confuse Starter with Standard", () => {
    /* The two differ by one word and by a lot of money. Naming the product in full
       switches the plan; nothing else does. */
    const { corrections } = planFor(
      "Make it Google Workspace Business Standard please.",
      { seats: 20, plan: "Google Workspace Business Starter" },
    );
    expect(corrections.find((c) => c.field === "plan")?.to)
      .toBe("Google Workspace Business Standard");
  });

  it("refuses a PARTIAL product name rather than guessing which SKU was meant", () => {
    /* "Business Standard" alone does not switch the plan, and that is deliberate —
       extract.ts matches the tenant's full catalogue name, longest first, because
       "Google Workspace Business Standard" contains "Google Workspace" and matching a
       fragment would quote the wrong plan at the wrong price.

       The cost is real and accepted: a customer who writes the common short form gets
       no automatic plan change, and the operator sees the reply unchanged. That is the
       right way round — a missed update is visible in the thread, a wrong one is
       invisible until the invoice. */
    const { corrections, skipped } = planFor(
      "Make it Business Standard please.",
      { seats: 20, plan: "Google Workspace Business Starter" },
    );
    expect(corrections.find((c) => c.field === "plan")).toBeUndefined();
    expect(skipped.find((s) => s.field === "plan")?.reason).toMatch(/no catalogue product/i);
  });

  it("treats a slug and its catalogue name as the same product", () => {
    /* leads.plan holds both shapes in live data. Comparing raw would report a change
       on every single reply and rewrite the row forever. */
    const { corrections } = planFor(
      "Yes, Business Starter is fine, 20 users.",
      { seats: 20, plan: "google-workspace-starter" },
    );
    expect(corrections.find((c) => c.field === "plan")).toBeUndefined();
  });

  it("fills a blank field and records it as blank, not as a change from nothing", () => {
    const { corrections } = planFor(
      "We need 30 users of Business Plus.",
      { seats: null, plan: null },
    );
    const seats = corrections.find((c) => c.field === "seats");
    expect(seats?.from).toBeNull();
    expect(correctionDetail(seats!)).toContain("(blank) → 30");
  });

  it("applies seats and plan independently", () => {
    /* A reply that changes only the count must not also rewrite the product. */
    const { corrections } = planFor("Actually make it 35 users.", LEAD);
    expect(corrections.map((c) => c.field)).toEqual(["seats"]);
  });

  it("says WHY it skipped, in words an operator can act on", () => {
    const { skipped } = planFor("Thanks.", LEAD);
    expect(skipped.length).toBeGreaterThan(0);
    for (const s of skipped) expect(s.reason.length).toBeGreaterThan(10);
  });
});

describe("planCorrections — Indian phrasing the extractor already handles", () => {
  /* These are the shapes real enquiries use. Worth asserting here because Phase 1
     WRITES what they produce, so a miss is now a stale record rather than a vague
     draft. */
  const cases: Array<[string, string]> = [
    ["Please quote for 20 email id of Business Standard", "20"],
    ["i need 15 licence of google workspace business standard", "15"],
    ["kindly send quotation for 12 users Business Standard", "12"],
  ];

  for (const [body, expected] of cases) {
    it(`reads "${body.slice(0, 38)}…" as ${expected} seats`, () => {
      const { corrections } = planFor(body);
      expect(corrections.find((c) => c.field === "seats")?.to).toBe(expected);
    });
  }
});

describe("planCorrections — the EXACT bytes from the database", () => {
  /* Copied verbatim out of inbound_emails.body_text for row
     acf87053-4410-4db4-bb5f-764d91d9b6ee. Not retyped: the three things that make this
     message hard are all invisible in a tidy transcription.

       1. CRLF line endings, which defeat a $-anchored marker regex.
       2. The product name WRAPPED mid-phrase — "Google Workspace Business\r\nStandard"
          — which an exact substring match against the catalogue misses.
       3. Both 20/Standard (theirs) and 50/Starter (ours, quoted) in one body.

     A fixture written by hand had none of them and passed while the real message
     would have failed on all three. */
  const STORED =
    "Hi,\r\n\r\nActually, I need the quotation for 20 users of Google Workspace Business\r\n" +
    "Standard, not 50 users of Starter. Please adjust that.\r\n\r\n" +
    "On Sat, 22 Aug 2026 at 21:54, <sales@anutech.in> wrote:\r\n\r\n" +
    "> Hi test,\r\n>\r\n> Thank you for your enquiry for 50 users of Google Workspace Business\r\n" +
    "> Starter. I am preparing the quotation now and will send it across\r\n> shortly.\r\n>\r\n" +
    "> If the number of users changes before then, just reply here and I will\r\n> adjust it.\r\n>\r\n" +
    "> Best regards,\r\n> ANUTECH DIGITAL PVT LTD\r\n>";

  it("produces exactly the two corrections the operator was owed", () => {
    const { corrections } = planFor(STORED);
    expect(corrections.map((c) => `${c.field}:${c.from}->${c.to}`)).toEqual([
      "seats:50->20",
      "plan:Google Workspace Business Starter->Google Workspace Business Standard",
    ]);
  });

  it("reads the WRAPPED product name across the line break", () => {
    /* The catalogue name is broken by \r\n in the real message. Before the flatten in
       extract.ts's findProduct this returned nothing, so the plan silently stayed
       Starter — a missed correction that looks identical to "nothing to correct". */
    const { corrections } = planFor(STORED);
    expect(corrections.find((c) => c.field === "plan")?.to)
      .toBe("Google Workspace Business Standard");
  });

  it("does not read 50 or Starter out of the quoted half", () => {
    const { corrections } = planFor(STORED);
    expect(corrections.find((c) => c.field === "seats")?.to).not.toBe("50");
    expect(corrections.find((c) => c.field === "plan")?.to).not.toContain("Starter");
  });
});
