import { describe, it, expect } from "vitest";
import {
  decideInboundRoute,
  localPart,
  addressDomain,
  newTicketId,
  type InboundRoute,
} from "./routing";

describe("localPart", () => {
  it("reads a bare address", () => {
    expect(localPart("sales@anutech.in")).toBe("sales");
  });

  it("unwraps a display name", () => {
    // Providers hand the recipient over in this shape constantly.
    expect(localPart("ANUTECH Sales <sales@anutech.in>")).toBe("sales");
  });

  it("strips a plus-tag — sales+website@ is still sales@", () => {
    expect(localPart("sales+website@anutech.in")).toBe("sales");
  });

  it("lower-cases", () => {
    expect(localPart("SUPPORT@ANUTECH.IN")).toBe("support");
  });

  it("returns '' for anything unusable", () => {
    for (const bad of ["", "not-an-address", "@anutech.in", null, undefined]) {
      expect(localPart(bad)).toBe("");
    }
  });
});

describe("addressDomain", () => {
  it("reads the domain, wrapped or bare", () => {
    expect(addressDomain("sales@anutech.in")).toBe("anutech.in");
    expect(addressDomain("Sales <sales@ANUTECH.in>")).toBe("anutech.in");
  });
  it("returns '' for a dotless host or junk", () => {
    expect(addressDomain("root@localhost")).toBe("");
    expect(addressDomain("nope")).toBe("");
  });
});

describe("decideInboundRoute — the three inboxes", () => {
  it.each<[string, InboundRoute]>([
    ["sales@anutech.in",    "sales"],
    ["enquiry@anutech.in",  "sales"],
    ["info@anutech.in",     "sales"],
    ["support@anutech.in",  "support"],
    ["help@anutech.in",     "support"],
    ["billing@anutech.in",  "billing"],
    ["accounts@anutech.in", "billing"],
    ["invoices@anutech.in", "billing"],
  ])("%s routes to %s", (to, expected) => {
    expect(decideInboundRoute(to).route).toBe(expected);
  });

  it("routes on the RECIPIENT, not on what the message sounds like", () => {
    // A customer asking support@ about renewal pricing is a support request,
    // however much it reads like a sales enquiry. The address is the sender's
    // own statement of intent; a model would disagree some of the time.
    expect(decideInboundRoute("support@anutech.in").route).toBe("support");
    expect(decideInboundRoute("sales@anutech.in").route).toBe("sales");
  });

  it("carries the mailbox and a reason for the audit trail", () => {
    const d = decideInboundRoute("billing@anutech.in");
    expect(d.mailbox).toBe("billing");
    expect(d.reason).toMatch(/billing/);
  });
});

describe("decideInboundRoute — machine mail must not become work", () => {
  it("ignores a no-reply SENDER whatever it was addressed to", () => {
    // Bounce notices and auto-replies arrive constantly. A pipeline that turns
    // them into leads fills the CRM with "Mail Delivery Subsystem".
    for (const from of [
      "noreply@somebank.in", "no-reply@vendor.com", "MAILER-DAEMON@googlemail.com",
      "postmaster@x.in", "bounces@mailchimp.com",
    ]) {
      expect(decideInboundRoute("sales@anutech.in", from).route).toBe("ignored");
    }
  });

  it("ignores a no-reply RECIPIENT too", () => {
    expect(decideInboundRoute("noreply@anutech.in").route).toBe("ignored");
  });

  it("does not ignore an ordinary sender", () => {
    expect(decideInboundRoute("sales@anutech.in", "vinay@truhomes.in").route).toBe("sales");
  });
});

describe("decideInboundRoute — the default is deliberately not 'drop it'", () => {
  it("an unmapped mailbox falls to sales, and says so", () => {
    // A new alias nobody added to the table must not make enquiries vanish. A
    // stray lead is deleted in a second; a silently dropped enquiry is a lost
    // customer nobody ever hears about.
    const d = decideInboundRoute("newteam@anutech.in");
    expect(d.route).toBe("sales");
    expect(d.reason).toMatch(/not a mapped inbox/i);
  });

  it("an unusable recipient still routes to sales rather than nowhere", () => {
    const d = decideInboundRoute(undefined);
    expect(d.route).toBe("sales");
    expect(d.reason).toMatch(/defaulting to sales/i);
  });

  it("never returns a route outside the four the database accepts", () => {
    const allowed = ["sales", "support", "billing", "ignored"];
    for (const to of ["sales@a.in", "support@a.in", "billing@a.in", "noreply@a.in", "weird@a.in", "", null]) {
      expect(allowed).toContain(decideInboundRoute(to).route);
    }
  });
});

describe("newTicketId", () => {
  it("matches the shape the customer portal already mints", () => {
    expect(newTicketId()).toMatch(/^TKT-[0-9A-Z]+-[0-9A-F]{2}$/);
  });
});
