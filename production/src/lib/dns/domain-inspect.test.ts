import { describe, it, expect } from "vitest";
import {
  MIGRATION_CLAIMS_FORBIDDEN,
  identifyProvider,
  inspectionFacts,
  normaliseDomain,
  type MxRecord,
} from "./domain-inspect";

const mx = (...hosts: string[]): MxRecord[] =>
  hosts.map((exchange, i) => ({ exchange, priority: (i + 1) * 10 }));

describe("normaliseDomain", () => {
  it.each([
    ["sharmatraders.in", "sharmatraders.in"],
    ["  SharmaTraders.IN  ", "sharmatraders.in"],
    ["https://sharmatraders.in/contact", "sharmatraders.in"],
    ["rahul@sharmatraders.in", "sharmatraders.in"],
    ["sharmatraders.in.", "sharmatraders.in"],
    ["sharmatraders.in:443", "sharmatraders.in"],
    ["mail.sharmatraders.co.in", "mail.sharmatraders.co.in"],
  ])("reads %s as %s", (raw, expected) => {
    expect(normaliseDomain(raw)).toBe(expected);
  });

  it.each([
    ["", "empty"],
    [null, "null"],
    ["localhost", "localhost"],
    ["server.local", "an internal suffix"],
    ["box.internal", "an internal suffix"],
    ["10.0.0.1", "an IPv4 literal"],
    ["192.168.1.1", "a private address"],
    ["nodots", "no dot"],
    ["trailing-.in", "a hyphen at a label edge"],
    ["site.example", "a reserved TLD"],
  ])("refuses %s (%s)", (raw, why) => {
    /* This value comes from a customer's message and becomes a network lookup. Refusing far
       more than strictly necessary costs nothing, because no real customer's domain looks like
       any of these. */
    expect(normaliseDomain(raw), `should refuse: ${why}`).toBeNull();
  });
});

describe("identifyProvider", () => {
  it.each([
    [["aspmx.l.google.com"], "Google Workspace"],
    [["sharmatraders-in.mail.protection.outlook.com"], "Microsoft 365"],
    [["mx.zoho.com", "mx2.zoho.com"], "Zoho Mail"],
    [["mx1.hostinger.in"], "Hostinger"],
    [["smtp.secureserver.net", "mailstore1.secureserver.net"], "GoDaddy"],
    [["mx.bigrock.in"], "BigRock"],
    [["mx.rediffmailpro.com"], "Rediffmail Pro"],
  ])("recognises %s as %s", (hosts, provider) => {
    const v = identifyProvider(mx(...hosts));
    expect(v.known).toBe(true);
    if (v.known) expect(v.provider).toBe(provider);
  });

  it("says UNRECOGNISED rather than guessing", () => {
    /* THE RULE. Guessing a provider is the same class of mistake as guessing a product from a
       bare "Standard" — a confident sentence about somebody's infrastructure that a machine
       invented, and the customer has no reason to doubt it. */
    const v = identifyProvider(mx("mail.someverysmallhost.co.in"));
    expect(v.known).toBe(false);
    if (!v.known) expect(v.reason).toBe("unrecognised");
  });

  it("reports no records as no_mx, not as unrecognised", () => {
    const v = identifyProvider([]);
    expect(v.known).toBe(false);
    if (!v.known) expect(v.reason).toBe("no_mx");
  });

  it("names the mailbox provider AND the filter in front of it", () => {
    /* Mimecast in front of Microsoft 365 means the MX says Mimecast and the mailboxes are still
       Microsoft's. Calling the filter their mail provider would be wrong. */
    const v = identifyProvider(mx("in-a.mimecast.com", "sharma-in.mail.protection.outlook.com"));
    expect(v.known).toBe(true);
    if (v.known) {
      expect(v.provider).toBe("Microsoft 365");
      expect(v.alsoFiltering).toBe("Mimecast (filtering)");
    }
  });

  it("does not pretend to know the mailbox host when only a filter is visible", () => {
    const v = identifyProvider(mx("in-a.mimecast.com"));
    expect(v.known).toBe(true);
    if (v.known) {
      expect(v.provider).toContain("Mimecast");
      expect(v.alsoFiltering).toBeNull();
    }
  });

  it("prefers the specific signature over the general one", () => {
    /* "aspmx.l.google.com" contains "google.com" too. Both map to the same name here, so the
       assertion is that the list order does not produce something odd. */
    const v = identifyProvider(mx("alt1.aspmx.l.google.com"));
    if (v.known) expect(v.provider).toBe("Google Workspace");
  });
});

describe("inspectionFacts", () => {
  const facts = (hosts: string[], domain = "sharmatraders.in") => {
    const records = mx(...hosts);
    return inspectionFacts({ domain, verdict: identifyProvider(records), mx: records }).join("\n");
  };

  it("states the current provider as an observation", () => {
    const text = facts(["mx1.hostinger.in"]);
    expect(text).toContain("sharmatraders.in's mail is currently handled by Hostinger");
  });

  it("forbids prescribing a replacement record IN THE SAME BREATH", () => {
    /* The line the existing record guard draws from the other side: `verifyNoInventedRecords`
       refuses a draft naming a record value nobody authorised, because a wrong MX read to a
       customer takes their mail down and they follow it exactly since we said it. Reading back
       what they HAVE is safe; telling them what to switch to is not. */
    const text = facts(["mx1.hostinger.in"]);
    expect(text).toContain("You may NOT tell them what to change any record to");
    expect(text).toContain("their own admin console");
  });

  it("treats a missing MX as a probable TYPO, not as 'you have no email'", () => {
    /* sharmatraders.in against sharmatraders.co.in. Telling a business with working mail that
       they have none is the fastest way to lose the technical credibility this feature exists
       to build. */
    const text = facts([]);
    expect(text).toContain("spelt differently");
    expect(text).toContain("ask them to confirm");
    /* Asserted as a PROHIBITION, not as an absent substring. The first version of this checked
       that "no email" never appeared, and failed on the module's own instruction — "rather than
       telling them they have no email". A test that forbids a phrase in the sentence that
       forbids the phrase is testing the wrong thing. */
    expect(text).toContain("rather than telling them they have no email");
  });

  it("tells the agent NOT to guess when the records are unrecognised", () => {
    const text = facts(["mail.someverysmallhost.co.in"]);
    expect(text).toContain("Do NOT guess");
    expect(text).toContain("ask them who runs their email today");
  });

  it("never contains a record value the app made up", () => {
    /* Only hosts that came out of the lookup appear. Nothing in this module knows a target MX,
       and there is no table of vendor records to leak from — support-agent.ts's header explains
       why inventing one would be worse than admitting we have none. */
    const text = facts(["mx1.hostinger.in"]);
    expect(text).not.toContain("aspmx");
    expect(text).not.toContain("TXT");
    expect(text).not.toContain("v=spf1");
  });
});

describe("MIGRATION_CLAIMS_FORBIDDEN — the sentence the brief asked for", () => {
  const all = MIGRATION_CLAIMS_FORBIDDEN.join(" | ");

  it("forbids a migration duration", () => {
    /* "bina kisi data loss ke 2 ghante mein migrate kar denge" — a duration for work whose
       length depends entirely on how many mailboxes there are and how big they are. */
    expect(all).toContain("how long a migration will take");
    expect(all).toContain("not in hours, not in days");
  });

  it("forbids a no-data-loss guarantee", () => {
    /* A guarantee about their current mail server, which we cannot see and do not control. */
    expect(all).toContain("no data will be lost");
  });

  it("forbids prescribing records or disparaging their host", () => {
    expect(all).toContain("only what they have now");
    expect(all).toContain("their current provider is bad");
  });
});
