/**
 * The one resolver for "who do I contact" — and the rules that keep it honest.
 *
 * This function is read by invoice dunning, the renewals cron, quote-send, WhatsApp
 * send, the AI follow-up drafter, the aging report, the portal and the public API. A
 * wrong answer here does not throw; it emails the wrong person, or nobody, and nothing
 * on any screen says so. So the cases below are all failure modes, not features.
 */
import { describe, it, expect, vi } from "vitest";
import { primaryContactsFor, primaryContactFor, primaryContactEmail } from "./primary";

type Row = {
  customer_id: string; full_name: string | null;
  email: string | null; phone: string | null; is_primary: boolean;
};

/**
 * A stub with just the two shapes the resolver uses.
 *
 * The rows are still written in the flat `Row` shape above, because that is what these
 * tests are ABOUT — which person gets chosen and why. The stub reshapes them into the
 * embedded form the resolver now reads (`customer_contacts` joined to `contacts`,
 * since migration 20260918090000), so every expectation below survived the move to a
 * person-serves-many-customers model unchanged. That is the point: the choosing rules
 * did not change, only where the link is stored.
 */
function db(contacts: Row[], customers: Array<Record<string, unknown>> = []) {
  const links = contacts.map((c) => ({
    customer_id: c.customer_id,
    is_primary:  c.is_primary,
    contacts: { full_name: c.full_name, email: c.email, phone: c.phone },
  }));
  return {
    from: (table: string) => {
      if (table === "customer_contacts") {
        return { select: () => ({ in: async () => ({ data: links, error: null }) }) };
      }
      if (table === "contacts") {
        return { select: () => ({ in: async () => ({ data: contacts, error: null }) }) };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: customers[0] ?? null, error: null }) }),
        }),
      };
    },
  } as unknown as Parameters<typeof primaryContactsFor>[0];
}

const row = (over: Partial<Row> = {}): Row => ({
  customer_id: "cust1", full_name: "Rajesh K",
  email: "rajesh@chandan.in", phone: "+91 98765 43210", is_primary: true,
  ...over,
});

describe("primaryContactsFor — many customers, one round trip", () => {
  it("picks the primary, not just any contact", async () => {
    const map = await primaryContactsFor(db([
      row({ full_name: "Sunita M", email: "sunita@chandan.in", is_primary: false }),
      row({ full_name: "Rajesh K", email: "rajesh@chandan.in", is_primary: true }),
    ]), ["cust1"]);
    expect(map.get("cust1")?.email).toBe("rajesh@chandan.in");
  });

  it("does not depend on row order — the primary can arrive last or first", async () => {
    const forward = await primaryContactsFor(db([
      row({ email: "primary@x.in", is_primary: true }),
      row({ email: "other@x.in",   is_primary: false }),
    ]), ["cust1"]);
    const reversed = await primaryContactsFor(db([
      row({ email: "other@x.in",   is_primary: false }),
      row({ email: "primary@x.in", is_primary: true }),
    ]), ["cust1"]);
    expect(forward.get("cust1")?.email).toBe("primary@x.in");
    expect(reversed.get("cust1")?.email).toBe("primary@x.in");
  });

  it("falls back to the first contact WITH an email when no primary is flagged", async () => {
    /* A customer whose primary flag was never set must still be reachable — and an
       emailless contact must not win over one that has an address. */
    const map = await primaryContactsFor(db([
      row({ full_name: "No Email", email: null,           is_primary: false }),
      row({ full_name: "Has Email", email: "has@x.in",    is_primary: false }),
    ]), ["cust1"]);
    expect(map.get("cust1")?.email).toBe("has@x.in");
  });

  it("keeps customers apart — one customer's contact never answers for another", async () => {
    const map = await primaryContactsFor(db([
      row({ customer_id: "cust1", email: "one@x.in" }),
      row({ customer_id: "cust2", email: "two@x.in" }),
    ]), ["cust1", "cust2"]);
    expect(map.get("cust1")?.email).toBe("one@x.in");
    expect(map.get("cust2")?.email).toBe("two@x.in");
  });

  it("returns nothing for a customer with no contacts, rather than someone else's", async () => {
    const map = await primaryContactsFor(db([row({ customer_id: "cust1" })]), ["cust1", "cust2"]);
    expect(map.has("cust2")).toBe(false);
  });

  it("makes no query at all for an empty list", async () => {
    const from = vi.fn();
    const map = await primaryContactsFor({ from } as never, []);
    expect(map.size).toBe(0);
    /* A nightly cron with nothing to chase should not hit the database. */
    expect(from).not.toHaveBeenCalled();
  });

  it("de-duplicates ids so one customer twice is still one lookup", async () => {
    const map = await primaryContactsFor(db([row()]), ["cust1", "cust1", "cust1"]);
    expect(map.size).toBe(1);
  });
});

describe("primaryContactFor — one customer", () => {
  it("returns the contact's name, email and phone", async () => {
    const c = await primaryContactFor(db([row()]), "cust1");
    expect(c).toMatchObject({
      name: "Rajesh K", email: "rajesh@chandan.in", phone: "+91 98765 43210", fromLegacy: false,
    });
  });

  it("returns empty rather than throwing when nobody is on file", async () => {
    const c = await primaryContactFor(db([]), "cust1");
    expect(c).toMatchObject({ customerId: "cust1", email: null, name: null });
  });
});

describe("primaryContactEmail — the legacy floor", () => {
  it("uses the contact row and reports it as NOT legacy", async () => {
    const r = await primaryContactEmail(db([row()]), "cust1");
    expect(r).toMatchObject({ email: "rajesh@chandan.in", fromLegacy: false });
  });

  it("falls back to customers.contact_email when no contact has one", async () => {
    /* The backfill covered every existing customer, but an import or an older code
       path could still create one without contacts. A dunning run that silently
       emails nobody is worse than one that uses yesterday's column. */
    const r = await primaryContactEmail(
      db([], [{ contact_email: "old@chandan.in", contact_name: "Old Rajesh" }]),
      "cust1",
    );
    expect(r).toMatchObject({ email: "old@chandan.in", fromLegacy: true });
  });

  it("reports null WITHOUT claiming legacy when there is genuinely nobody", async () => {
    /* The distinction matters: `fromLegacy: true` here would hide the real gap behind
       a "we used the old column" story, and nobody would go and add a contact. */
    const r = await primaryContactEmail(db([], []), "cust1");
    expect(r.email).toBeNull();
    expect(r.fromLegacy).toBe(false);
  });

  it("prefers a contact row over the legacy column when both exist", async () => {
    const r = await primaryContactEmail(
      db([row({ email: "new@chandan.in" })], [{ contact_email: "old@chandan.in" }]),
      "cust1",
    );
    expect(r.email).toBe("new@chandan.in");
  });

  it("treats a blank contact email as absent, not as an address", async () => {
    const r = await primaryContactEmail(
      db([row({ email: "   " })], [{ contact_email: "old@chandan.in" }]),
      "cust1",
    );
    expect(r.email).toBe("old@chandan.in");
  });
});

/**
 * One person, several customers — the thing this could not do until 18 Sep 2026.
 *
 * `contacts.customer_id` was a single column, so a person belonged to exactly one
 * customer. Combined with "one email is one person", that made a real arrangement
 * unrepresentable: a consultant who looks after three of your customers. Abhishek hit it
 * trying to reuse an address that was already on another customer.
 *
 * The link now lives in `customer_contacts`, and the failure mode to guard against is
 * the quiet one: resolving that person for their FIRST customer only, so the other
 * customers' invoices and payment reminders go to nobody.
 */
describe("a contact who serves several customers", () => {
  it("resolves the SAME person for every customer they are linked to", async () => {
    const shared = { full_name: "Ravi Menon", email: "ravi@consult.in", phone: "+91 90000 11111" };
    const d = db([
      { customer_id: "cust1", ...shared, is_primary: true },
      { customer_id: "cust2", ...shared, is_primary: true },
      { customer_id: "cust3", ...shared, is_primary: true },
    ]);
    const got = await primaryContactsFor(d, ["cust1", "cust2", "cust3"]);
    /* All three, not just the first. Two of them silently missing is exactly how a
       dunning run emails nobody. */
    expect(got.size).toBe(3);
    for (const id of ["cust1", "cust2", "cust3"]) {
      expect(got.get(id)?.email).toBe("ravi@consult.in");
      expect(got.get(id)?.fromLegacy).toBe(false);
    }
  });

  it("lets the same person be primary for one customer and not another", async () => {
    /* Primary-ness belongs to the RELATIONSHIP. Ravi is the primary for cust1, but on
       cust2 the customer's own finance person is — and that is who gets their invoice. */
    const d = db([
      { customer_id: "cust1", full_name: "Ravi Menon", email: "ravi@consult.in", phone: null, is_primary: true },
      { customer_id: "cust2", full_name: "Ravi Menon", email: "ravi@consult.in", phone: null, is_primary: false },
      { customer_id: "cust2", full_name: "Meera S", email: "meera@beta.in", phone: null, is_primary: true },
    ]);
    const got = await primaryContactsFor(d, ["cust1", "cust2"]);
    expect(got.get("cust1")?.email).toBe("ravi@consult.in");
    expect(got.get("cust2")?.email).toBe("meera@beta.in");
  });
});
