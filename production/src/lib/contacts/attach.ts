/**
 * Give a customer its primary contact — the one writer, used by every path that
 * creates a customer.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Two places create customers from a form: the Add Subscription dialog and the
 * Customers page. Until 18 Sep 2026 they did it differently, and the difference was
 * invisible until it cost money:
 *
 *   • the dialog wrote `contacts` AND the `customer_contacts` link
 *   • useCreateCustomer wrote only `contacts`, with `customer_id` set
 *
 * Since migration 20260918090000 the invoice and dunning recipient resolver
 * (`primaryContactsFor`) reads the LINK table and does not consult
 * `contacts.customer_id`. So every customer added from the Customers page had a contact
 * on screen and no contact as far as the money paths were concerned — the reminder run
 * would find nobody and fall through to the legacy column, or to nothing at all.
 *
 * One function, so the two paths cannot drift again.
 *
 * ─── WHY IT RESOLVES BEFORE IT CREATES ──────────────────────────────────────
 * `contacts_unique_email_per_tenant` says one email is one person. A person now serves
 * many customers, so an email already on file is not a clash to refuse — it is the same
 * human, and the right move is to link them to this customer as well. That is Abhishek's
 * instruction of 18 Sep 2026, after creating FF Impex with an email already on Doodh
 * Sang's contact and being told "duplicate".
 *
 * ─── WHY IT RETURNS INSTEAD OF THROWING ─────────────────────────────────────
 * The caller has to decide what to undo. A customer created seconds ago with nobody on
 * it must not survive (the caller deletes it); a customer that already existed must not
 * be touched. Only the caller knows which it is, so the outcome travels back to it —
 * with the database's own reason attached, because "couldn't save the contact" with
 * nothing after it is a dead end (§24).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { newContactId } from "@/lib/queries/contacts";

/* Minimal shape, so this works with the browser client, the server client and the
   admin client without importing any of them. Same trick as contacts/primary.ts. */
type Db = Pick<SupabaseClient, "from">;

export interface AttachPrimaryContactInput {
  tenantId: string;
  customerId: string;
  /** The person's name. Required — a customer with no named human is the bug. */
  name: string;
  email?: string | null;
  phone?: string | null;
  /** What they do FOR THIS CUSTOMER. Stored on the link, and on a new person row. */
  role?: string | null;
  /** The customer's name, so a contact read on its own still says who it belongs to. */
  company?: string | null;
  /**
   * An id the operator explicitly picked from the suggestions list. Trusted above the
   * email match, because it is a decision rather than an inference.
   */
  contactId?: string | null;
}

export type AttachPrimaryContactResult =
  /** A new person was created and linked. */
  | { kind: "created"; contactId: string }
  /** Somebody already on file was linked to this customer as well. */
  | { kind: "linked"; contactId: string }
  /** This customer already had a contact; nothing was written. */
  | { kind: "already" }
  /** Nothing was written and the customer has nobody. The caller must not proceed. */
  | { kind: "failed"; reason: string };

export async function attachPrimaryContact(
  db: Db, input: AttachPrimaryContactInput,
): Promise<AttachPrimaryContactResult> {
  const { tenantId, customerId, company } = input;
  const name  = (input.name ?? "").trim();
  const email = (input.email ?? "").trim();
  const phone = (input.phone ?? "").trim();
  const role  = input.role || null;

  if (!name) {
    return { kind: "failed", reason: "No contact person was given." };
  }

  /* Already served? Then this is an existing customer being sold to again, and the
     typed details are not a correction — silently overwriting somebody's primary
     contact because a second subscription was sold would be worse than ignoring them. */
  const { data: already, error: alreadyErr } = await db
    .from("customer_contacts")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .limit(1);
  if (alreadyErr) {
    return { kind: "failed", reason: alreadyErr.message || "Could not check this customer's existing contacts." };
  }
  if (already && already.length > 0) return { kind: "already" };

  /* ── Find the person, in order of confidence ───────────────────────────────
       1. the operator picked them from the suggestions → that id, certainly
       2. the email matches somebody                    → that person
       3. nobody matches                                → a new person        */
  let contactRowId = (input.contactId ?? "").trim() || null;
  if (!contactRowId && email) {
    const { data: byEmail } = await db
      .from("contacts").select("id").eq("tenant_id", tenantId)
      .ilike("email", email).limit(1);
    contactRowId = (byEmail?.[0] as { id?: string } | undefined)?.id ?? null;
  }

  if (contactRowId) {
    const { error } = await db.from("customer_contacts").insert({
      tenant_id: tenantId, customer_id: customerId, contact_id: contactRowId,
      role, is_primary: true,
    });
    if (error) {
      console.error("[contacts] linking an existing contact failed:", error);
      return { kind: "failed", reason: error.message || "Could not attach that contact to this customer." };
    }
    return { kind: "linked", contactId: contactRowId };
  }

  const newId = newContactId();
  const { error: insErr } = await db.from("contacts").insert({
    id: newId,
    tenant_id: tenantId,
    /* Kept for the files still reading the legacy column — it records the person's
       FIRST customer. The link below is the real relationship. */
    customer_id: customerId,
    full_name: name,
    /* `|| null` rather than "": an empty string in an email column satisfies a NOT NULL
       check, passes a truthiness guard in some languages, and matches every other blank
       when deduping contacts. */
    email: email || null,
    phone: phone || null,
    company: company ?? null,
    role,
    /* The first contact a customer has IS the primary. Nothing else could be: there is
       nobody to compete with, and an unset primary is an invoice with no recipient. */
    is_primary: true,
    /* An operator typed this, so 'manual' — and 'engaged', because a customer who is
       buying is by definition not a pending lead. Both vocabularies are constrained
       (contacts_source_check / contacts_status_check). */
    source: "manual",
    status: "engaged",
  });
  if (insErr) {
    console.error("[contacts] contact insert failed:", insErr);
    return { kind: "failed", reason: insErr.message || "The database refused the contact row." };
  }

  /* A person with no link serves nobody — the resolver that picks who gets invoices and
     reminders reads customer_contacts, not the contact row. */
  const { error: linkErr } = await db.from("customer_contacts").insert({
    tenant_id: tenantId, customer_id: customerId, contact_id: newId,
    role, is_primary: true,
  });
  if (linkErr) {
    console.error("[contacts] linking a new contact failed:", linkErr);
    return { kind: "failed", reason: linkErr.message || "The contact was saved but could not be attached to this customer." };
  }
  return { kind: "created", contactId: newId };
}
