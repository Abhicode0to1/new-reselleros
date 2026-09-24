/**
 * Automatic domain registration after payment — the pure rules on the paying side.
 *
 * Owner decisions, 24 Sep 2026 (Todos.md §0A, 21-24): a domain paid for on the
 * site is registered automatically, under the customer's own details, into a DMS
 * account for them, within a spend limit the ENGINE enforces
 * (DMS lib/integrations/engine-register-policy.ts).
 *
 * This side has its own fail-closed gate, `DOMAIN_REGISTRATION_LIVE`: only the
 * exact string "1" lets the worker send a live command. The engine has a second,
 * independent one (`ENGINE_DOMAIN_REGISTER_LIVE`). Both are off until the owner
 * approves a first real registration.
 */

export interface Registrant {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  phoneCc: string;
  companyName?: string;
  address: { line1: string; city: string; state: string; country: string; zipcode: string };
}

/** The paying side's gate. Exact "1" only (AGENTS.md L41). */
export function domainRegistrationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.DOMAIN_REGISTRATION_LIVE === "1";
}

/**
 * The command id for one attempt at one provisioning request.
 *
 * One id per request PER DAY (IST). The engine replays a repeated id, so within
 * a day every retry is a free replay of the same outcome. A HELD attempt (daily
 * cap reached, say) wrote nothing, so the next day's new id may be evaluated
 * afresh. A registration that DID land is caught by the engine before any spend
 * ("already registered to this customer"), and one awaiting reconciliation keeps
 * its subject locked, so a new day's id cannot register twice.
 */
export function registrationCommandId(requestId: string, now: Date = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000); // AGENTS.md §6 — IST, not UTC
  return `rsos-domreg-${requestId}-${ist.toISOString().slice(0, 10)}`;
}

/** Rupees paid before GST, from the payment amount (which includes 18%). */
export function coverFromPaid(amountPaidInclGst: number): number {
  return Math.max(0, Math.floor(amountPaidInclGst / 1.18));
}

/**
 * The registrant recorded on the quote's domain line for this domain, or null.
 * The cart checkout writes it there (checkout/cart route); a quote raised any
 * other way has none, and then the worker holds the request for a person.
 */
export function registrantFor(lineItems: unknown, domain: string): Registrant | null {
  if (!Array.isArray(lineItems)) return null;
  const want = domain.trim().toLowerCase();
  for (const l of lineItems) {
    const line = (l && typeof l === "object" ? l : {}) as { domain?: unknown; registrant?: unknown };
    if (typeof line.domain === "string" && line.domain.toLowerCase() === want && line.registrant && typeof line.registrant === "object") {
      return line.registrant as Registrant;
    }
  }
  return null;
}

/** Split "Asha K Verma" into first + last; a single word is used for both, as RC requires both. */
export function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/** Indian mobile/landline digits without the 91 prefix; other input kept as digits. */
export function normalisePhone(raw: string): { phone: string; phoneCc: string } {
  let d = raw.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return { phone: d, phoneCc: "91" };
}
