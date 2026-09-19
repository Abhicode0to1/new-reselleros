/**
 * ResellerClub — the registrant identity a domain is registered UNDER.
 *
 * Ported from the DMS engine's `lib/resellerclub/customers.ts` (664 lines) on
 * 9 Sep 2026, onto this repo's `rcCall` + `classify` spine. Four of its defects
 * are fixed here rather than carried across; each is named below, because the
 * next person to compare the two files needs to know the differences are
 * deliberate.
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `api/cron/provision-domain` refused to file a registration unless
 * RESELLERCLUB_CUSTOMER_ID and RESELLERCLUB_CONTACT_ID were set by hand, and it
 * refused ON PURPOSE: a domain filed under the wrong registrant is a support
 * case that ends with a transfer-out, and every customer sharing one hardcoded
 * identity is exactly that. Until this module existed there was no way to get
 * the right ids, so the whole registrar write path was gated off in practice.
 *
 * ─── WHAT RC MEANS BY "CUSTOMER" AND "CONTACT" ───────────────────────────────
 * Two different objects, and both are needed to register:
 *   · a CUSTOMER is the account holder at RC — one per email, reusable forever;
 *   · a CONTACT is the registrant record that goes to the REGISTRY and shows in
 *     WHOIS. It hangs off a customer.
 * So the shape is: find-or-create the customer, then create the contact.
 *
 * ─── THE FOUR DMS DEFECTS NOT PORTED ─────────────────────────────────────────
 *
 * 1. A FAILED LOOKUP WAS READ AS "CUSTOMER DOES NOT EXIST", which then created a
 *    SECOND customer. DMS's `getCustomerId` wrapped its call in try/catch and
 *    returned `status:"not_found"` from the catch — so a timeout, an auth error,
 *    or RC's IP-whitelist rejection all meant "go ahead and create". The result
 *    is a duplicate RC account and a domain under the wrong one. Here the lookup
 *    goes through `classifyLookup`, which only says `not_found` when RC's own
 *    message matches READ_NOT_FOUND_FRAGMENTS, and says `hard_failure` for
 *    everything else. `rcEnsureRegistrant` creates ONLY on `not_found`.
 *    This is the same defect class the handoff already caught in DMS's
 *    renew/transfer path: an error that does not look like one.
 *
 * 2. IT LOGGED THE GENERATED PASSWORD. DMS logged
 *    `{ password: tempPassword, passwordLength, ... }` at info level on every
 *    creation. Nothing here logs the password, and it is never returned to a
 *    caller either — it is not needed after signup, because we act through the
 *    reseller API key and not as the customer.
 *
 * 3. IT INVENTED REGISTRANT DATA. Missing fields fell back to
 *    "Default Address" / "Default City" / "Default State" / zipcode "000000".
 *    That is filed with the REGISTRY and published in WHOIS, and inaccurate
 *    registrant data is grounds for suspension under ICANN's RAA — so the
 *    fallback trades a visible refusal for an invisible risk to the domain. This
 *    module REFUSES when the address is incomplete and says which field is
 *    missing, so the failure lands in the provisioning queue where somebody can
 *    fix the customer record.
 *
 * 4. `parseInt(String(res.data))` ASSUMED THE TRANSPORT PASSED SCALARS THROUGH.
 *    RC answers `customers/signup.json` and `contacts/add.json` with a BARE
 *    NUMBER, and our `rcCall` rejected non-object bodies as unreadable — so
 *    every successful creation would have read as a failure. Handled by
 *    `allowScalar` in call.ts, measured before this file was written.
 */
import "server-only";
import { randomInt } from "node:crypto";
import { rcCall, rcOrderingEnabled, rcWriteConfigured } from "./call";
import { classifyLookup, type LookupOutcome } from "./classify";

/* ── Inputs ─────────────────────────────────────────────────────────────────── */

export interface RcRegistrantInput {
  /** RC uses this as the customer's username, so it must be the real address. */
  email: string;
  name: string;
  companyName?: string | null;
  phone: string;
  /** Country calling code without the "+". Defaults to India. */
  phoneCc?: string | null;
  address: {
    line1: string;
    city: string;
    state: string;
    /** ISO-3166 alpha-2. Defaults to IN. */
    country?: string | null;
    zipcode: string;
  };
}

export type RcIdentityOutcome =
  /** Both ids are in hand. `createdCustomer` is false when an existing one was reused. */
  | { kind: "ready"; customerId: string; contactId: string; createdCustomer: boolean }
  /**
   * A precondition of OURS failed — an incomplete registrant, or the gate being
   * shut. Nothing was sent to RC, so retrying the same input cannot help; the
   * data has to change first. Distinct from `hard_failure` for that reason.
   */
  | { kind: "refused"; reason: string }
  /** RC said no, or its answer left the upstream state unknown. */
  | { kind: "hard_failure"; reason: string };

/* ── Validation ─────────────────────────────────────────────────────────────── */

/** Digits only. RC rejects spaces, dashes and a leading "+" in `phone`. */
function digits(value: string): string {
  return (value || "").replace(/\D/g, "");
}

/**
 * Every field the registry needs, checked before anything is sent.
 *
 * Returns the missing field NAMES rather than a boolean, because
 * "customer 4f2a is missing city, zipcode" is a thing somebody can act on and
 * "invalid registrant" is not (§24).
 */
function missingRegistrantFields(input: RcRegistrantInput): string[] {
  const missing: string[] = [];
  if (!input.email?.trim() || !input.email.includes("@")) missing.push("email");
  if (!input.name?.trim()) missing.push("name");
  if (digits(input.phone || "").length < 6) missing.push("phone");
  if (!input.address?.line1?.trim()) missing.push("address.line1");
  if (!input.address?.city?.trim()) missing.push("address.city");
  if (!input.address?.state?.trim()) missing.push("address.state");
  if (!input.address?.zipcode?.trim()) missing.push("address.zipcode");
  return missing;
}

/**
 * A password that satisfies RC's signup rule (8-15 chars, and it rejects
 * all-lowercase) without ever being logged or returned.
 *
 * We never use it: this app acts on the account through the reseller api-key,
 * not as the customer. It exists because signup.json demands one. If a customer
 * ever needs to log in to RC directly, that is a password RESET, not a secret
 * this app should be storing.
 */
function throwawayPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const nums = "23456789";
  const pick = (set: string, n: number) =>
    Array.from({ length: n }, () => set[randomInt(0, set.length)]).join("");
  return pick(upper, 2) + pick(lower, 6) + pick(nums, 4);
}

/* ── Reads ──────────────────────────────────────────────────────────────────── */

/**
 * The RC customer id for an email, or a clear `not_found` / `hard_failure`.
 *
 * The distinction is the whole point of this function — see defect 1 above.
 */
export async function rcCustomerIdFor(email: string): Promise<LookupOutcome<string>> {
  const res = await rcCall("/api/customers/details.json", { username: email.trim() }, "GET");
  return classifyLookup(res, (data) => {
    const id = data["customerid"] ?? data["customer-id"] ?? data["id"];
    if (id === null || id === undefined) return null;
    const str = String(id).trim();
    return str.length > 0 ? str : null;
  });
}

/* ── Writes ─────────────────────────────────────────────────────────────────── */

type CreateOutcome =
  | { kind: "created"; id: string }
  | { kind: "hard_failure"; reason: string };

/** Pull the new id out of RC's answer, whether it came back bare or wrapped. */
function newIdFrom(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  const raw = data["value"] ?? data["customerid"] ?? data["contactid"] ?? data["id"];
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  return /^\d+$/.test(str) ? str : null;
}

export async function rcCreateCustomer(input: RcRegistrantInput): Promise<CreateOutcome> {
  const res = await rcCall(
    "/api/customers/signup.json",
    {
      username: input.email.trim(),
      passwd: throwawayPassword(),
      name: input.name.trim(),
      company: (input.companyName || input.name).trim(),
      "address-line-1": input.address.line1.trim(),
      city: input.address.city.trim(),
      state: input.address.state.trim(),
      country: (input.address.country || "IN").trim().toUpperCase(),
      zipcode: input.address.zipcode.trim(),
      "phone-cc": digits(input.phoneCc || "91") || "91",
      phone: digits(input.phone),
      "lang-pref": "en",
    },
    "POST",
    { allowScalar: true },
  );

  if (res.status !== "success") {
    return { kind: "hard_failure", reason: res.message || "ResellerClub refused the customer signup" };
  }
  const id = newIdFrom(res.data);
  if (!id) {
    /* Do NOT treat this as a failure to create — RC may well have created the
       customer and answered in a shape we did not expect. Saying "unknown"
       keeps the caller from creating a second one. */
    return { kind: "hard_failure", reason: "ResellerClub accepted the signup but returned no customer id" };
  }
  return { kind: "created", id };
}

export async function rcCreateContact(
  customerId: string,
  input: RcRegistrantInput,
): Promise<CreateOutcome> {
  const res = await rcCall(
    "/api/contacts/add.json",
    {
      "customer-id": customerId,
      name: input.name.trim(),
      company: (input.companyName || input.name).trim(),
      email: input.email.trim(),
      "address-line-1": input.address.line1.trim(),
      city: input.address.city.trim(),
      state: input.address.state.trim(),
      country: (input.address.country || "IN").trim().toUpperCase(),
      zipcode: input.address.zipcode.trim(),
      "phone-cc": digits(input.phoneCc || "91") || "91",
      phone: digits(input.phone),
      type: "Contact",
    },
    "POST",
    { allowScalar: true },
  );

  if (res.status !== "success") {
    return { kind: "hard_failure", reason: res.message || "ResellerClub refused the contact" };
  }
  const id = newIdFrom(res.data);
  if (!id) {
    return { kind: "hard_failure", reason: "ResellerClub accepted the contact but returned no contact id" };
  }
  return { kind: "created", id };
}

/* ── The one a caller wants ─────────────────────────────────────────────────── */

/**
 * Find-or-create the RC customer for this registrant, then create their contact.
 *
 * Ordering is not interchangeable: a contact needs a customer id, so a failure
 * to resolve the customer must stop before any contact is filed. And the
 * customer lookup must be allowed to say "I do not know" — creating on an
 * unknown is how you end up with two accounts for one person.
 */
export async function rcEnsureRegistrant(input: RcRegistrantInput): Promise<RcIdentityOutcome> {
  if (!rcWriteConfigured()) {
    return { kind: "refused", reason: "ResellerClub credentials are not configured in this environment" };
  }
  if (!rcOrderingEnabled()) {
    return { kind: "refused", reason: "DOMAIN_REGISTER_LIVE is not 1 — the registrar write path is shut" };
  }

  const missing = missingRegistrantFields(input);
  if (missing.length > 0) {
    /* Refused, not failed: the registry would publish whatever we sent, and an
       inaccurate WHOIS record is grounds for suspension. See defect 3. */
    return {
      kind: "refused",
      reason: `the registrant record is incomplete — missing ${missing.join(", ")}. A registry filing must carry accurate details, so this is not defaulted.`,
    };
  }

  const existing = await rcCustomerIdFor(input.email);

  let customerId: string;
  let createdCustomer = false;

  if (existing.kind === "found") {
    customerId = existing.value;
  } else if (existing.kind === "hard_failure") {
    /* The defect-1 guard. We do not know whether this customer exists, so we do
       not create one. */
    return {
      kind: "hard_failure",
      reason: `could not determine whether a ResellerClub customer already exists for ${input.email} (${existing.reason}) — refusing to create one, because a duplicate puts the domain under the wrong account`,
    };
  } else {
    const created = await rcCreateCustomer(input);
    if (created.kind !== "created") return { kind: "hard_failure", reason: created.reason };
    customerId = created.id;
    createdCustomer = true;
  }

  const contact = await rcCreateContact(customerId, input);
  if (contact.kind !== "created") {
    return {
      kind: "hard_failure",
      /* Naming the customer id matters: it exists upstream now, and whoever
         retries should reuse it rather than make a second one. */
      reason: `${contact.reason} (ResellerClub customer ${customerId} ${createdCustomer ? "was created" : "already existed"} and should be reused on retry)`,
    };
  }

  return { kind: "ready", customerId, contactId: contact.id, createdCustomer };
}
