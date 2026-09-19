/**
 * Who to contact for a customer — the one resolver every caller uses.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The same fact used to live in three places, two of them dead: the flat
 * `customers.contact_*` columns the whole app read, a `contact_persons` jsonb nobody
 * filled, and a `contacts` table with a `customer_id` and zero rows.
 *
 * Abhishek's decision, 10 Sep 2026: ONE identity. A customer's people live in
 * `contacts`, one of them marked `is_primary`, and that person receives invoices and
 * payment reminders. Extended 18 Sep 2026: a person can serve SEVERAL customers, so the
 * link — and with it `is_primary` — lives in `customer_contacts`. This resolver reads
 * that table; `contacts.customer_id` is legacy and is not consulted. He was explicitly offered the cheaper option — keep
 * `customers.contact_email` auto-synced as a mirror so the ~16 readers never change —
 * and chose the proper conversion: one truth, no cached copy that can drift.
 *
 * ─── WHY A SINGLE FUNCTION AND NOT 16 EDITS ─────────────────────────────────
 * The readers are invoice dunning, the renewals cron, quote-send, WhatsApp send, the
 * AI follow-up drafter, the aging report, the portal and the public API. If each
 * resolved "the primary contact" its own way, they would eventually disagree about who
 * gets chased — and the one that disagrees quietly is the one that emails nobody.
 *
 * ─── AND WHY IT FALLS BACK ──────────────────────────────────────────────────
 * `primaryContactEmail` falls back to the customer's legacy `contact_email` when no
 * contact row answers. Not a mirror — a floor. Migration 20260910100000 backfilled
 * every existing customer, but a row created by an import or an older code path could
 * still arrive without contacts, and a dunning run that silently emails nobody is
 * worse than one that uses the column it used yesterday. The fallback is logged by the
 * caller where it matters, so it stays visible rather than becoming the norm.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface PrimaryContact {
  customerId: string;
  name:  string | null;
  email: string | null;
  phone: string | null;
  /** True when this came from the legacy customers.contact_* columns, not a contact
   *  row — so a caller can log it rather than let the gap go unnoticed. */
  fromLegacy: boolean;
}

/* Minimal shape, so this works with the browser client, the server client and the
   admin client without importing any of them. */
type Db = Pick<SupabaseClient, "from">;

const EMPTY: Omit<PrimaryContact, "customerId"> = {
  name: null, email: null, phone: null, fromLegacy: false,
};

/**
 * The primary contact for MANY customers, in one round trip.
 *
 * Use this in list views and crons. Calling the single-customer version inside a loop
 * over 200 invoices is 200 queries, which is how a nightly job starts timing out.
 */
export async function primaryContactsFor(
  db: Db, customerIds: readonly string[],
): Promise<Map<string, PrimaryContact>> {
  const out = new Map<string, PrimaryContact>();
  const ids = [...new Set(customerIds.filter(Boolean))];
  if (ids.length === 0) return out;

  /* ── READS THE LINK TABLE, NOT contacts.customer_id ──────────────────────
     Since 18 Sep 2026 one person can serve several customers (migration
     20260918090000), so "whose contact is this" is a property of the LINK, not of the
     contact row. Reading `contacts.customer_id` here would find only the person's first
     customer and email nobody for the others — on the dunning path, which is the one
     that chases money.

     The embed pulls the person through the link in one round trip; `contacts(...)` is
     the foreign-key relationship PostgREST exposes from customer_contacts. */
  const { data: links } = await db
    .from("customer_contacts")
    .select("customer_id, is_primary, contacts(full_name, email, phone)")
    .in("customer_id", ids);

  type LinkRow = {
    customer_id: string;
    is_primary: boolean | null;
    contacts: { full_name: string | null; email: string | null; phone: string | null } | null;
  };
  const data = ((links ?? []) as unknown as LinkRow[]).map((l) => ({
    customer_id: l.customer_id,
    full_name:   l.contacts?.full_name ?? null,
    email:       l.contacts?.email ?? null,
    phone:       l.contacts?.phone ?? null,
    is_primary:  l.is_primary ?? false,
  }));

  /* Primary wins; otherwise the first contact with an email, so a customer whose
     primary flag was never set is still reachable. Order is not guaranteed by the
     query, so the choice is made here rather than by relying on it. */
  for (const id of ids) {
    const rows = data.filter((r) => r.customer_id === id);
    const chosen =
      rows.find((r) => r.is_primary)
      ?? rows.find((r) => (r.email ?? "").trim() !== "")
      ?? rows[0];
    if (chosen) {
      out.set(id, {
        customerId: id,
        name:  chosen.full_name ?? null,
        email: chosen.email ?? null,
        phone: chosen.phone ?? null,
        fromLegacy: false,
      });
    }
  }
  return out;
}

/** The primary contact for ONE customer. */
export async function primaryContactFor(
  db: Db, customerId: string,
): Promise<PrimaryContact> {
  const map = await primaryContactsFor(db, [customerId]);
  return map.get(customerId) ?? { customerId, ...EMPTY };
}

/**
 * The email to write to, with the legacy column as a floor.
 *
 * Returns null only when there is genuinely nobody — which the caller must treat as
 * "cannot send", not as "send to nowhere".
 */
export async function primaryContactEmail(
  db: Db, customerId: string,
): Promise<{ email: string | null; name: string | null; fromLegacy: boolean }> {
  const found = await primaryContactFor(db, customerId);
  if ((found.email ?? "").trim() !== "") {
    return { email: found.email, name: found.name, fromLegacy: false };
  }
  const { data: legacy } = await db
    .from("customers")
    .select("contact_email, contact_name")
    .eq("id", customerId)
    .maybeSingle();
  const email = (legacy?.contact_email ?? "").trim() || null;
  return {
    email,
    name: found.name ?? legacy?.contact_name ?? null,
    /* Only "legacy" when it actually supplied the address — otherwise a customer with
       no contact anywhere would be reported as a legacy hit and hide the real gap. */
    fromLegacy: email !== null,
  };
}
