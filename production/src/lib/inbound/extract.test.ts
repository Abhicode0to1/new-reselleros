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
