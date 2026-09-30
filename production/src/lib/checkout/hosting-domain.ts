/**
 * The domain a hosting account (paid or trial) is set up on — one rule for the checkout
 * form and the server (owner, 30 Sep 2026: "when buying the hosting plan, providing a
 * domain is compulsory", and that includes the free trial, which until then accepted none).
 *
 * The check was `length >= 3`, so "mywebsite" passed. A hosting account needs a real
 * domain name, so this asks for one: labels of letters, digits and hyphens, a dot, and an
 * extension. "https://", "www." and a trailing slash are forgiven, since that is how people
 * paste a site address.
 */
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The bare domain, lower-cased, or null when it is not a domain name. */
export function hostingDomain(raw: string | null | undefined): string | null {
  const d = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
  return DOMAIN.test(d) ? d : null;
}

/** Where a buyer without a domain can get one. */
export const BUY_A_DOMAIN_HREF = "/domains";
