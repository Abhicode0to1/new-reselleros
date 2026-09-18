import { describe, it, expect } from "vitest";
import {
  buildContactSearchIndex,
  customerMatchesContact,
  type ContactLinkRow,
} from "./search-index";

const link = (
  customerId: string, contactId: string,
  person: { full_name?: string | null; email?: string | null; phone?: string | null } | null,
): ContactLinkRow => ({
  customer_id: customerId,
  contact_id: contactId,
  contacts: person
    ? { full_name: person.full_name ?? null, email: person.email ?? null, phone: person.phone ?? null }
    : null,
});

/* The case the whole feature exists for: Anjali looks after two companies. */
const ANJALI_ON_BOTH: ContactLinkRow[] = [
  link("cust-doodh", "C-ANJALI", { full_name: "Anjali Tomar", email: "anjali@doodhsang.in", phone: "9876543210" }),
  link("cust-ffimpex", "C-ANJALI", { full_name: "Anjali Tomar", email: "anjali@doodhsang.in", phone: "9876543210" }),
  link("cust-accesstel", "C-RANJEET", { full_name: "Ranjeet Kumar", email: "ranjeet@accesstel.in", phone: "9812345678" }),
];

describe("buildContactSearchIndex", () => {
  it("finds BOTH customers one person serves", () => {
    // The bug this replaces: customers.contact_name holds only the first contact, so
    // searching "anjali" found one company and silently missed the other.
    const ix = buildContactSearchIndex(ANJALI_ON_BOTH);

    expect(customerMatchesContact(ix, "cust-doodh", "anjali")).toBe(true);
    expect(customerMatchesContact(ix, "cust-ffimpex", "anjali")).toBe(true);
    expect(customerMatchesContact(ix, "cust-accesstel", "anjali")).toBe(false);
  });

  it("matches on email — what you paste out of a thread", () => {
    const ix = buildContactSearchIndex(ANJALI_ON_BOTH);
    expect(customerMatchesContact(ix, "cust-ffimpex", "anjali@doodhsang.in")).toBe(true);
  });

  it("matches on phone — often the only thing in front of you on a call", () => {
    const ix = buildContactSearchIndex(ANJALI_ON_BOTH);
    expect(customerMatchesContact(ix, "cust-accesstel", "9812345678")).toBe(true);
  });

  it("is case-insensitive on the stored side", () => {
    const ix = buildContactSearchIndex([link("c1", "p1", { full_name: "RAJESH KUMAR" })]);
    expect(customerMatchesContact(ix, "c1", "rajesh")).toBe(true);
  });

  it("folds every person on a customer into one haystack", () => {
    // Two people on one company; either name must find it.
    const ix = buildContactSearchIndex([
      link("c1", "p1", { full_name: "Rajesh Kumar" }),
      link("c1", "p2", { full_name: "Sunita Rao" }),
    ]);
    expect(customerMatchesContact(ix, "c1", "rajesh")).toBe(true);
    expect(customerMatchesContact(ix, "c1", "sunita")).toBe(true);
  });

  it("never matches an empty query", () => {
    // Otherwise clearing the search box would filter to "customers that have contacts",
    // which is not what an empty box means anywhere else on either page.
    const ix = buildContactSearchIndex(ANJALI_ON_BOTH);
    expect(customerMatchesContact(ix, "cust-doodh", "")).toBe(false);
  });

  it("returns false for a customer with no contacts at all", () => {
    const ix = buildContactSearchIndex(ANJALI_ON_BOTH);
    expect(customerMatchesContact(ix, "cust-unknown", "anjali")).toBe(false);
  });

  it("survives a link whose person could not be embedded", () => {
    // RLS or a deleted contact can leave the embed null. A crash in a search predicate
    // takes the whole list down, which is far worse than one row not matching.
    const ix = buildContactSearchIndex([link("c1", "p1", null)]);
    expect(customerMatchesContact(ix, "c1", "anything")).toBe(false);
    expect(ix.customerCountByContact.get("p1")).toBe(1);
  });
});

describe("how many customers one person serves", () => {
  it("counts each customer once", () => {
    const ix = buildContactSearchIndex(ANJALI_ON_BOTH);
    expect(ix.customerCountByContact.get("C-ANJALI")).toBe(2);
    expect(ix.customerCountByContact.get("C-RANJEET")).toBe(1);
  });

  it("does not double-count a duplicated link row", () => {
    const rows = [...ANJALI_ON_BOTH, link("cust-doodh", "C-ANJALI", { full_name: "Anjali Tomar" })];
    const ix = buildContactSearchIndex(rows);
    expect(ix.customerCountByContact.get("C-ANJALI")).toBe(2);
  });

  it("keeps the customer ids, so the chip can link through to them", () => {
    const ix = buildContactSearchIndex(ANJALI_ON_BOTH);
    expect(ix.customerIdsByContact.get("C-ANJALI")).toEqual(["cust-doodh", "cust-ffimpex"]);
  });
});
