import { describe, it, expect } from "vitest";
import { pillsFor, pillDraft, replySubject, type PillContext } from "./reply-pills";

/** The live enquiry: Pardeep, 20 seats, Google Workspace Standard, no phone number. */
const LIVE: PillContext = {
  contactName: "Pardeep Sharma",
  product: "Google Workspace Standard",
  seats: 20,
  hasPhone: false,
  sellerName: "ANUTECH DIGITAL PVT LTD",
};

describe("a pill is only worth a tap if it knows the enquiry", () => {
  it("repeats back what they actually asked for", () => {
    const d = pillDraft("quote", LIVE);
    expect(d).toContain("20 users");
    expect(d).toContain("Google Workspace Standard");
  });

  it("greets by FIRST name — a full name reads like a form letter", () => {
    expect(pillDraft("quote", LIVE)).toContain("Hi Pardeep,");
    expect(pillDraft("quote", LIVE)).not.toContain("Hi Pardeep Sharma");
  });

  it("says plain 'Hello' rather than 'Hi there' when the name is unknown", () => {
    /* A greeting that admits it does not know you is worse than none. */
    const d = pillDraft("quote", { ...LIVE, contactName: null });
    expect(d).toContain("Hello,");
    expect(d).not.toMatch(/hi there/i);
  });

  it("does not invent a name out of an email handle or junk", () => {
    for (const junk of ["", "   ", "1234", "-", "a"]) {
      expect(pillDraft("quote", { ...LIVE, contactName: junk })).toContain("Hello,");
    }
  });

  it("simply omits what it does not know, rather than leaving a gap", () => {
    const d = pillDraft("quote", { contactName: null, product: null, seats: null });
    expect(d).not.toMatch(/for\s*\./);
    expect(d).not.toMatch(/undefined|null|NaN/);
  });

  it("uses the singular for one seat", () => {
    expect(pillDraft("quote", { ...LIVE, seats: 1 })).toContain("1 user");
    expect(pillDraft("quote", { ...LIVE, seats: 1 })).not.toContain("1 users");
  });
});

/**
 * ─── NO PRICES, EVER ────────────────────────────────────────────────────────
 * Pricing has one home: the quote builder, where the catalogue rate, the discount and the
 * GST split are computed together. A number typed into an email is one nobody can
 * reconcile against the invoice that follows — and the customer will hold us to it.
 */
describe("no pill quotes a price", () => {
  it.each(["quote", "phone", "call"] as const)("%s carries no rupee figure", (id) => {
    const d = pillDraft(id, LIVE);
    expect(d).not.toMatch(/₹|rs\.?\s*\d|\d{3,}\s*(?:per|\/)/i);
  });

  it("promises the quote instead of pricing it", () => {
    expect(pillDraft("quote", LIVE)).toMatch(/preparing the quotation/i);
  });
});

/**
 * ─── NO PLACEHOLDERS ────────────────────────────────────────────────────────
 * A draft containing "[insert date]" is a draft that gets sent containing "[insert date]".
 */
describe("nothing needs filling in by hand", () => {
  it.each(["quote", "phone", "call"] as const)("%s has no bracketed blanks", (id) => {
    const d = pillDraft(id, LIVE);
    expect(d).not.toMatch(/\[[^\]]*\]|<[^>]*>|XXX|TBD/i);
  });

  it("offers relative times, not invented calendar dates", () => {
    /* This module cannot know the reseller's calendar. "Tuesday 3pm" would put a
       commitment in their mouth. */
    const d = pillDraft("call", LIVE);
    expect(d).toMatch(/tomorrow morning|late afternoon/i);
    expect(d).not.toMatch(/\b(?:mon|tue|wed|thu|fri)day\b/i);
  });

  it("gives two concrete windows rather than 'let me know when suits'", () => {
    /* An open question is the most common way a warm enquiry goes quiet. */
    expect(pillDraft("call", LIVE)).toMatch(/whichever is easier/i);
  });
});

describe("which pills are offered", () => {
  it("offers the phone ask ONLY when there is no number", () => {
    /* Asking a customer for something already on file makes the reseller look like they
       did not read the email. */
    expect(pillsFor(LIVE).map((p) => p.id)).toContain("phone");
    expect(pillsFor({ ...LIVE, hasPhone: true }).map((p) => p.id)).not.toContain("phone");
  });

  it("always offers the quote and the call", () => {
    for (const ctx of [LIVE, { ...LIVE, hasPhone: true }, {}]) {
      const ids = pillsFor(ctx).map((p) => p.id);
      expect(ids).toContain("quote");
      expect(ids).toContain("call");
    }
  });

  it("gives every pill a reason, shown on hover", () => {
    for (const p of pillsFor(LIVE)) expect(p.hint.length).toBeGreaterThan(25);
  });
});

describe("the sign-off", () => {
  it("signs with the tenant", () => {
    expect(pillDraft("quote", LIVE)).toContain("ANUTECH DIGITAL PVT LTD");
  });

  it("goes UNSIGNED when the seller is unknown, never with a placeholder", () => {
    /* Same rule as lib/whatsapp.ts: no name beats the wrong name. */
    const d = pillDraft("quote", { ...LIVE, sellerName: null });
    expect(d).not.toMatch(/best regards/i);
    expect(d).not.toMatch(/excel technologies/i);
  });
});

describe("the reply subject", () => {
  it("prefixes Re: so the customer's client threads it", () => {
    expect(replySubject("mujhe 20 email chahiye")).toBe("Re: mujhe 20 email chahiye");
  });

  it("does NOT stack a second Re:", () => {
    /* "Re: Re: Re:" is the surest sign an inbox was built by somebody who never used one. */
    expect(replySubject("Re: pricing")).toBe("Re: pricing");
    expect(replySubject("RE: pricing")).toBe("RE: pricing");
  });

  it("falls back to something meaningful on a subject-less email", () => {
    expect(replySubject(null)).toBe("Re: your enquiry");
    expect(replySubject("   ")).toBe("Re: your enquiry");
  });
});
