/**
 * DMS `users` → this app's `customers`.
 *
 * ─── WHY THIS IS THE ONLY THING BEING IMPORTED FROM DMS ──────────────────────
 * The Atlas snapshot was read on 9 Sep 2026 before any migration was written:
 * 1,005 documents, and the transactional half is test data. The only hosting
 * account is `tt.com`; the two orders are a ₹2 trial and a ₹599.88 renewal
 * carrying invoice numbers INV-000031/33 that would put foreign numbers into a
 * GST-relevant series; prices are non-integer (49.99) where our columns are
 * integer rupees; and `items.wholesale` is NOT NULL while DMS has no cost price
 * at all, so any imported catalogue would feed invented costs into P&L.
 *
 * Contact records carry none of that risk — no money, no numbering, no
 * accounting — so they are the one thing worth bringing across. TASKS.md has the
 * full measurement.
 *
 * ─── WHAT IT REFUSES TO IMPORT, AND WHY EACH ONE ─────────────────────────────
 * Of DMS's 8 users, 3 are not customers at all. The function returns a `skip`
 * with a reason rather than a filter someone has to reverse-engineer:
 *
 *   · `role: "admin"` — that is a staff login of the business itself. Importing it
 *     as a customer would create an account that appears to owe money to itself.
 *   · `isGuest: true` — guest-checkout artifacts, and both of DMS's are literally
 *     named "test" and "test2". A guest row is a session, not a relationship.
 *   · `isDeleted: true` — somebody already decided this record should be gone.
 *   · no email — there is nothing to identify the row by, so a re-run could not
 *     recognise it and would duplicate on every import.
 *
 * ─── EVERY IMPORTED ROW SAYS WHERE IT CAME FROM ──────────────────────────────
 * `notes` carries the provenance line. A snapshot import that leaves no trace is
 * one nobody can audit later, and this is a copy of a source that is still live
 * and still changing.
 */

/**
 * DMS stores an ISO code; this app stores the display name.
 *
 * `customers.country` is fed by a DROPDOWN whose values are the full names in
 * `lib/gst/countries.ts` ("India"), and that list is a dropdown precisely so the
 * value cannot drift — `isExportSupply` treats anything that is not India as a
 * zero-rated export. Measured 9 Sep 2026: every DMS user has `address.country`
 * = "IN", and "IN" is NOT in COUNTRIES, so importing it verbatim leaves the
 * country selector on those rows matching no option.
 *
 * No GST risk either way — place-of-supply.ts already counts "in" as domestic —
 * but a value the form cannot display is still a value somebody has to fix by
 * hand later. Only the domestic aliases are translated; anything else is passed
 * through untouched rather than guessed at.
 */
const DOMESTIC_ALIASES = new Set(["in", "ind", "india", "bharat"]);

export function canonicalCountry(v: string | null): string {
  const c = (v ?? "").trim();
  if (c === "") return "India";
  return DOMESTIC_ALIASES.has(c.toLowerCase()) ? "India" : c;
}

export interface DmsUserDoc {
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  role?: string | null;
  isGuest?: boolean | null;
  isDeleted?: boolean | null;
  companyName?: string | null;
  phone?: string | null;
  phoneCc?: string | null;
  whatsappNumber?: string | null;
  gstNumber?: string | null;
  address?: {
    line1?: string | null;
    city?: string | null;
    state?: string | null;
    zipcode?: string | null;
    country?: string | null;
  } | null;
  createdAt?: string | Date | null;
}

export interface CustomerInsert {
  tenant_id: string;
  name: string;
  /** Set only when DMS's companyName was actually a domain — see looksLikeBareDomain. */
  domain: string | null;
  display_name: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contact_mobile: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pin_code: string | null;
  gstin: string | null;
  country: string;
  since: string | null;
  notes: string;
}

export type MapUserOutcome =
  | { kind: "import"; row: CustomerInsert; email: string }
  | { kind: "skip"; reason: string };

const clean = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > 0 ? s : null;
};

/**
 * "+91 9810012345" from DMS's split fields.
 *
 * Kept as one readable string rather than two columns because `contact_phone` is
 * what the app dials and shows, and a country code sitting in a separate column
 * that nothing reads is a column that goes stale.
 */
export function joinPhone(cc: unknown, phone: unknown): string | null {
  const digits = (v: unknown) => (typeof v === "string" ? v.replace(/\D/g, "") : "");
  const p = digits(phone);
  if (p.length < 6) return null;
  const c = digits(cc);
  return c ? `+${c} ${p}` : p;
}

/** ISO date only — `customers.since` is a date, and a timestamp there is noise. */
function isoDate(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

/**
 * "excel.com" is a domain somebody typed into the company field, not a company.
 *
 * One of DMS's five importable users has exactly that, and taking it as the
 * account name puts a hostname in the identity column of every list. `customers`
 * has a `domain` column for this, so the value is kept — just not as the name.
 * The test is deliberately narrow: no whitespace, no @, and a dot with something
 * either side. "Acme Corp Pvt Ltd" and "A.B. Traders" are unaffected.
 */
export function looksLikeBareDomain(v: string | null): boolean {
  if (!v) return false;
  return /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/i.test(v) && !v.includes("@") && !/\s/.test(v);
}

/**
 * The name a person would recognise the account by.
 *
 * Company first, because that is who the invoice is for; then the person's name;
 * and only then the email's local part. `customers.name` is NOT NULL and it is
 * the identity column on every list — a blank there loses the row, so the
 * fallback chain exists to make sure something real always lands in it.
 */
export function customerName(u: DmsUserDoc): string | null {
  const company = clean(u.companyName);
  if (company && !looksLikeBareDomain(company)) return company;
  const person = [clean(u.firstName), clean(u.lastName)].filter(Boolean).join(" ").trim();
  if (person) return person;
  const email = clean(u.email);
  const local = email ? email.split("@")[0] : null;
  return local ? local : null;
}

export function mapDmsUser(u: DmsUserDoc, tenantId: string, importedAt = new Date()): MapUserOutcome {
  const email = clean(u.email);
  if (!email) return { kind: "skip", reason: "no email — nothing to identify or de-duplicate the row by" };
  if (u.isDeleted) return { kind: "skip", reason: "isDeleted in DMS — somebody already removed this record" };
  if (clean(u.role) === "admin") {
    return { kind: "skip", reason: "role=admin — a staff login of the business, not a customer of it" };
  }
  if (u.isGuest) {
    return { kind: "skip", reason: "isGuest — a guest-checkout session, not a customer relationship" };
  }

  const name = customerName(u);
  if (!name) return { kind: "skip", reason: "no company, no name and no usable email local part" };

  const a = u.address ?? {};
  return {
    kind: "import",
    email: email.toLowerCase(),
    row: {
      tenant_id: tenantId,
      name,
      display_name: name,
      domain: looksLikeBareDomain(clean(u.companyName)) ? clean(u.companyName) : null,
      contact_first_name: clean(u.firstName),
      contact_last_name: clean(u.lastName),
      contact_email: email.toLowerCase(),
      contact_phone: joinPhone(u.phoneCc, u.phone),
      contact_mobile: joinPhone(u.phoneCc, u.whatsappNumber),
      address: clean(a.line1),
      city: clean(a.city),
      state: clean(a.state),
      pin_code: clean(a.zipcode),
      gstin: clean(u.gstNumber),
      /* NOT NULL, and normalised to the name the country dropdown uses — see
         canonicalCountry. DMS's "IN" would otherwise match no option in the form. */
      country: canonicalCountry(clean(a.country)),
      since: isoDate(u.createdAt),
      notes: `Imported from the DMS snapshot on ${importedAt.toISOString().slice(0, 10)} (source: MongoDB domain-management.users). Contact details only — no orders, payments or invoices were imported; see TASKS.md for why.`,
    },
  };
}
