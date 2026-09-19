/**
 * attachPrimaryContact — the one writer both customer-creating paths use.
 *
 * What is actually being defended here is Abhishek's rule of 18 Sep 2026: "without
 * contact customer not created". This function is the half that decides whether a
 * customer HAS a contact; the callers undo the customer when it says no. So the cases
 * that matter most are the failures — a failure that reads as success is a customer on
 * the books with nobody to invoice, which is precisely the bug this replaced.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { attachPrimaryContact } from "./attach";

type Row = Record<string, unknown>;

/**
 * A Supabase double that records what was written, in order. Order is part of the
 * contract: the link must go in AFTER the person exists, or the foreign key refuses it.
 */
function makeDb(opts: {
  existingLinks?: Row[];
  contactsByEmail?: Row[];
  failOn?: "contacts" | "customer_contacts" | "existingLinkRead";
} = {}) {
  const writes: Array<{ table: string; row: Row }> = [];
  const err = (m: string) => ({ message: m });

  const from = vi.fn((table: string) => {
    const api: Record<string, unknown> = {
      insert: (row: Row) => {
        if (opts.failOn === table) return Promise.resolve({ error: err(`${table} refused`) });
        writes.push({ table, row });
        return Promise.resolve({ error: null });
      },
    };
    // Reads are chainable and resolve at .limit().
    const chain = {
      select: () => chain,
      eq: () => chain,
      ilike: () => chain,
      limit: () =>
        Promise.resolve(
          table === "customer_contacts"
            ? opts.failOn === "existingLinkRead"
              ? { data: null, error: err("could not read links") }
              : { data: opts.existingLinks ?? [], error: null }
            : { data: opts.contactsByEmail ?? [], error: null },
        ),
    };
    api.select = chain.select;
    return api as never;
  });

  return { db: { from } as never, writes };
}

const BASE = {
  tenantId: "t-1",
  customerId: "cust-1",
  name: "Anjali Tomar",
  email: "anjali@ffimpex.in",
  phone: "9876543210",
  role: "owner",
  company: "FF Impex",
};

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

describe("attachPrimaryContact — creating a new person", () => {
  it("writes the person, then the link, in that order", async () => {
    const { db, writes } = makeDb();
    const out = await attachPrimaryContact(db, BASE);

    expect(out.kind).toBe("created");
    expect(writes.map((w) => w.table)).toEqual(["contacts", "customer_contacts"]);
  });

  it("marks them primary on the LINK — that is what the invoice lookup reads", async () => {
    const { db, writes } = makeDb();
    await attachPrimaryContact(db, BASE);

    const link = writes.find((w) => w.table === "customer_contacts")!.row;
    expect(link.is_primary).toBe(true);
    expect(link.customer_id).toBe("cust-1");
    expect(link.role).toBe("owner");
  });

  it("stores a blank email as null, never as an empty string", async () => {
    // "" satisfies a NOT NULL check and matches every other blank when deduping —
    // two contacts with no email would look like the same person.
    const { db, writes } = makeDb();
    await attachPrimaryContact(db, { ...BASE, email: "", phone: "" });

    const person = writes.find((w) => w.table === "contacts")!.row;
    expect(person.email).toBeNull();
    expect(person.phone).toBeNull();
  });
});

describe("attachPrimaryContact — a person already on file", () => {
  it("links them instead of creating a second row for the same human", async () => {
    // The 18 Sep failure: this email belonged to Doodh Sang's contact, and the unique
    // email index refused the sale. The same person now simply serves both customers.
    const { db, writes } = makeDb({ contactsByEmail: [{ id: "C-EXISTING" }] });
    const out = await attachPrimaryContact(db, BASE);

    expect(out).toEqual({ kind: "linked", contactId: "C-EXISTING" });
    expect(writes.map((w) => w.table)).toEqual(["customer_contacts"]);
    expect(writes[0].row.contact_id).toBe("C-EXISTING");
  });

  it("prefers the id the operator clicked over whatever the email matches", async () => {
    // Clicking a suggestion is a decision; matching an email is an inference.
    const { db, writes } = makeDb({ contactsByEmail: [{ id: "C-BY-EMAIL" }] });
    const out = await attachPrimaryContact(db, { ...BASE, contactId: "C-PICKED" });

    expect(out).toEqual({ kind: "linked", contactId: "C-PICKED" });
    expect(writes[0].row.contact_id).toBe("C-PICKED");
  });

  it("leaves a customer that already has contacts completely alone", async () => {
    // Their people were curated on their own page; a second sale must not overwrite
    // who gets their invoices.
    const { db, writes } = makeDb({ existingLinks: [{ id: "link-1" }] });
    const out = await attachPrimaryContact(db, BASE);

    expect(out).toEqual({ kind: "already" });
    expect(writes).toHaveLength(0);
  });
});

describe("attachPrimaryContact — failures the caller must act on", () => {
  it("refuses an empty name without touching the database", async () => {
    const { db, writes } = makeDb();
    const out = await attachPrimaryContact(db, { ...BASE, name: "   " });

    expect(out.kind).toBe("failed");
    expect(writes).toHaveLength(0);
  });

  it("reports the database's own reason, not a generic apology", async () => {
    // §24: "couldn't save the contact" with nothing after it is a dead end.
    const { db } = makeDb({ failOn: "contacts" });
    const out = await attachPrimaryContact(db, BASE);

    expect(out).toEqual({ kind: "failed", reason: "contacts refused" });
  });

  it("fails when the person was written but the LINK was not", async () => {
    // The worst shape: a contact row exists, so the customer page shows a person,
    // while the invoice lookup — which reads only the link — finds nobody. Reporting
    // success here is how a contactless customer survives.
    const { db, writes } = makeDb({ failOn: "customer_contacts" });
    const out = await attachPrimaryContact(db, BASE);

    expect(out.kind).toBe("failed");
    expect(writes.map((w) => w.table)).toEqual(["contacts"]);
  });

  it("fails rather than guessing when the existing-contacts check errors", async () => {
    // Treating an unreadable check as "no contacts" would insert a second primary and
    // hit customer_contacts_one_primary — a 23505 in place of a clear message.
    const { db, writes } = makeDb({ failOn: "existingLinkRead" });
    const out = await attachPrimaryContact(db, BASE);

    expect(out.kind).toBe("failed");
    expect(writes).toHaveLength(0);
  });
});
