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

/** One hosting plan in the cart, in cart order, with the domain the customer typed for it. */
export interface PlanDomainInput {
  /** What the customer sees, e.g. "Standard hosting". Used only in messages. */
  label: string;
  typed: string | null | undefined;
}

export type PlanDomainsResult =
  | { ok: true; domains: string[] }
  | { ok: false; problems: string[] };

/**
 * The domain each hosting plan is set up on (30 Sep 2026, owner: "A domain for each plan at
 * checkout ... two plans can't share a domain").
 *
 * One rule for the checkout form and the server, like hostingDomain() above:
 * - every plan needs a real domain name of its own;
 * - two plans on the same domain is refused — one domain is one hosting account;
 * - with exactly ONE plan and nothing typed, a single domain being bought in the same cart
 *   is used (the bundle case, as before).
 *
 * Returns the domains in the same order as `plans`, or every problem at once so the customer
 * fixes them in one go.
 */
export function planDomains(plans: PlanDomainInput[], domainsBought: string[] = []): PlanDomainsResult {
  const problems: string[] = [];
  const domains: string[] = [];
  const several = plans.length > 1;
  plans.forEach((p, i) => {
    const typed = (p.typed ?? "").trim();
    const d = typed ? hostingDomain(typed) : !several && domainsBought.length === 1 ? hostingDomain(domainsBought[0]) : null;
    const which = several ? `your ${p.label}` : "your hosting";
    if (!typed && !d) problems.push(`the domain for ${which} (like yourcompany.in)`);
    else if (!d) problems.push(`a valid domain for ${which} (like yourcompany.in)`);
    else {
      const first = domains.indexOf(d);
      if (first >= 0) problems.push(`a different domain for your ${p.label} — ${d} is already on your ${plans[first].label}`);
      domains[i] = d;
    }
  });
  return problems.length ? { ok: false, problems } : { ok: true, domains };
}
