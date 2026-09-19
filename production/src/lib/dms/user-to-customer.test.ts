import { describe, it, expect } from "vitest";
import { mapDmsUser, customerName, joinPhone, looksLikeBareDomain, canonicalCountry, type DmsUserDoc } from "./user-to-customer";

/**
 * An import runs once against a source nobody will re-read, so the rules have to
 * be right the first time. Most of these tests are about what must NOT come
 * across: of DMS's 8 users, 3 are not customers, and each is excluded for a
 * different reason that would be invisible in a filter expression.
 */

const TENANT = "22222222-2222-2222-2222-222222222222";
const AT = new Date("2026-09-09T00:00:00Z");

const user = (over: Partial<DmsUserDoc> = {}): DmsUserDoc => ({
  email: "rajesh@acmecorp.com",
  firstName: "Rajesh",
  lastName: "Kumar",
  role: "user",
  ...over,
});

describe("who is NOT a customer", () => {
  it("skips the admin — a staff login of the business, not a customer of it", () => {
    const out = mapDmsUser(user({ role: "admin" }), TENANT, AT);
    expect(out.kind).toBe("skip");
    expect(out.kind === "skip" && out.reason).toMatch(/staff login/);
  });

  it("skips guest-checkout rows", () => {
    const out = mapDmsUser(user({ isGuest: true, firstName: "test", lastName: "" }), TENANT, AT);
    expect(out.kind).toBe("skip");
    expect(out.kind === "skip" && out.reason).toMatch(/guest-checkout/);
  });

  it("skips anything DMS already deleted", () => {
    expect(mapDmsUser(user({ isDeleted: true }), TENANT, AT).kind).toBe("skip");
  });

  it("skips a row with no email, because a re-run could not recognise it", () => {
    /* The email is the de-duplication key. Without one, every import would insert
       another copy. */
    const out = mapDmsUser(user({ email: "" }), TENANT, AT);
    expect(out.kind).toBe("skip");
    expect(out.kind === "skip" && out.reason).toMatch(/de-duplicate/);
  });

  it("gives a REASON for every skip, never a bare false", () => {
    const skips = [
      user({ role: "admin" }), user({ isGuest: true }), user({ isDeleted: true }), user({ email: null }),
    ].map((u) => mapDmsUser(u, TENANT, AT));
    for (const s of skips) {
      expect(s.kind).toBe("skip");
      expect(s.kind === "skip" && s.reason.length).toBeGreaterThan(20);
    }
  });
});

describe("the identity column can never be blank", () => {
  it("prefers the company, because that is who an invoice is for", () => {
    expect(customerName(user({ companyName: "Acme Corp Pvt Ltd" }))).toBe("Acme Corp Pvt Ltd");
  });

  it("falls back to the person's name", () => {
    expect(customerName(user({ companyName: null }))).toBe("Rajesh Kumar");
  });

  it("falls back again to the email's local part rather than importing a blank", () => {
    /* customers.name is NOT NULL and is the identity column on every list — a row
       with a blank name has lost whose it is. */
    expect(customerName(user({ companyName: null, firstName: null, lastName: null }))).toBe("rajesh");
  });

  it("copes with a half-populated person", () => {
    expect(customerName(user({ companyName: null, lastName: null }))).toBe("Rajesh");
    expect(customerName(user({ companyName: null, firstName: "  " }))).toBe("Kumar");
  });

  it("returns null only when there is genuinely nothing", () => {
    expect(customerName({ email: null, firstName: null, lastName: null, companyName: null })).toBeNull();
  });
});

describe("a domain typed into the company field is a domain", () => {
  it("does not become the account name", () => {
    /* One of DMS's importable users has companyName "excel.com". Taking that as
       the name puts a hostname in the identity column of every list. */
    expect(customerName(user({ companyName: "excel.com" }))).toBe("Rajesh Kumar");
  });

  it("is kept, in the column that exists for it", () => {
    const out = mapDmsUser(user({ companyName: "excel.com" }), TENANT, AT);
    expect(out.kind === "import" && out.row.domain).toBe("excel.com");
    expect(out.kind === "import" && out.row.name).toBe("Rajesh Kumar");
  });

  it("leaves a real company name alone, including punctuated ones", () => {
    for (const real of ["Acme Corp Pvt Ltd", "A.B. Traders", "Excel Technologies"]) {
      expect(looksLikeBareDomain(real)).toBe(false);
      expect(customerName(user({ companyName: real }))).toBe(real);
    }
    const out = mapDmsUser(user({ companyName: "Acme Corp Pvt Ltd" }), TENANT, AT);
    expect(out.kind === "import" && out.row.domain).toBeNull();
  });

  it("recognises the shapes that are domains", () => {
    for (const d of ["excel.com", "sub.excel.co.in", "my-shop.in"]) expect(looksLikeBareDomain(d)).toBe(true);
    for (const n of ["excel", "a@b.com", "excel .com", ""]) expect(looksLikeBareDomain(n)).toBe(false);
  });
});

describe("country is stored as the dropdown's value, not DMS's ISO code", () => {
  it("turns DMS's 'IN' into 'India' — the only value COUNTRIES offers", () => {
    /* Measured: every DMS user has address.country = "IN", and "IN" is not in
       lib/gst/countries.ts, so importing it verbatim leaves the selector on those
       rows matching no option. */
    expect(canonicalCountry("IN")).toBe("India");
    const out = mapDmsUser(user({ address: { country: "IN" } }), TENANT, AT);
    expect(out.kind === "import" && out.row.country).toBe("India");
  });

  it("accepts the other domestic spellings", () => {
    for (const v of ["in", "IND", "india", "Bharat", " India "]) expect(canonicalCountry(v)).toBe("India");
  });

  it("defaults an empty country to India rather than failing a NOT NULL insert", () => {
    expect(canonicalCountry(null)).toBe("India");
    expect(canonicalCountry("   ")).toBe("India");
  });

  it("passes a foreign country through instead of guessing at it", () => {
    /* Getting this wrong in the other direction zero-rates a domestic supply. */
    expect(canonicalCountry("United Arab Emirates")).toBe("United Arab Emirates");
    expect(canonicalCountry("Singapore")).toBe("Singapore");
  });
});

describe("joinPhone", () => {
  it("puts the country code back on the number", () => {
    expect(joinPhone("91", "9810012345")).toBe("+91 9810012345");
    expect(joinPhone("+91", "98100 12345")).toBe("+91 9810012345");
  });

  it("returns the number alone when DMS has no country code", () => {
    expect(joinPhone(null, "9810012345")).toBe("9810012345");
  });

  it("returns null rather than a fragment that looks like a phone number", () => {
    expect(joinPhone("91", "12345")).toBeNull();
    expect(joinPhone("91", null)).toBeNull();
    expect(joinPhone("91", "n/a")).toBeNull();
  });
});

describe("what an imported row carries", () => {
  const full = user({
    companyName: "Acme Corp Pvt Ltd",
    phone: "9810012345",
    phoneCc: "91",
    whatsappNumber: "9810099999",
    gstNumber: "06AABCA1234A1Z5",
    address: { line1: "12 MG Road", city: "Gurugram", state: "Haryana", zipcode: "122001", country: "India" },
    createdAt: "2026-08-13T06:35:56.712Z",
  });

  it("maps the contact fields DMS actually has", () => {
    const out = mapDmsUser(full, TENANT, AT);
    expect(out.kind).toBe("import");
    if (out.kind !== "import") return;
    expect(out.row).toMatchObject({
      tenant_id: TENANT,
      name: "Acme Corp Pvt Ltd",
      contact_first_name: "Rajesh",
      contact_email: "rajesh@acmecorp.com",
      contact_phone: "+91 9810012345",
      contact_mobile: "+91 9810099999",
      address: "12 MG Road",
      city: "Gurugram",
      state: "Haryana",
      pin_code: "122001",
      gstin: "06AABCA1234A1Z5",
      country: "India",
      since: "2026-08-13",
    });
  });

  it("lower-cases the email, so a re-run matches whatever case DMS stored", () => {
    const out = mapDmsUser(user({ email: "Rajesh@AcmeCorp.com" }), TENANT, AT);
    expect(out.kind === "import" && out.email).toBe("rajesh@acmecorp.com");
    expect(out.kind === "import" && out.row.contact_email).toBe("rajesh@acmecorp.com");
  });

  it("defaults country, because the column is NOT NULL", () => {
    const out = mapDmsUser(user({ address: { country: null } }), TENANT, AT);
    expect(out.kind === "import" && out.row.country).toBe("India");
  });

  it("leaves absent detail null instead of inventing it", () => {
    /* Five of DMS's users have nothing but an email and a country. An empty
       string in `city` reads as "we know the city and it is blank". */
    const out = mapDmsUser(user({ address: { country: "India" } }), TENANT, AT);
    if (out.kind !== "import") throw new Error("expected import");
    expect(out.row.address).toBeNull();
    expect(out.row.city).toBeNull();
    expect(out.row.state).toBeNull();
    expect(out.row.pin_code).toBeNull();
    expect(out.row.gstin).toBeNull();
    expect(out.row.contact_phone).toBeNull();
  });

  it("says where the row came from, and that no money came with it", () => {
    const out = mapDmsUser(full, TENANT, AT);
    if (out.kind !== "import") throw new Error("expected import");
    expect(out.row.notes).toMatch(/DMS snapshot on 2026-09-09/);
    expect(out.row.notes).toMatch(/no orders, payments or invoices/);
  });

  it("survives a document with no address object at all", () => {
    const out = mapDmsUser(user({ address: null }), TENANT, AT);
    expect(out.kind).toBe("import");
    expect(out.kind === "import" && out.row.country).toBe("India");
  });
});
