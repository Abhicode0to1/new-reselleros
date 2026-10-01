/**
 * One hosting account per order, for now (owner, 28 Sep 2026).
 *
 * Checkout keeps ONE hosting plan and ONE hosting domain per order, and the webhook queues one
 * hosting request per order. Until 28 Sep 2026 a cart holding two hosting plans, or one plan
 * with quantity 2, was charged in full and only the first account was ever set up — the rest
 * was paid for and never delivered. Taking several plans in one order is planned (each plan with
 * its own domain and its own provisioning request); until that exists end to end, this refuses
 * the order before anything is saved or charged.
 */

export interface HostingLimitLine {
  sku?: string;
  qty: number;
}

const isHosting = (sku: string | undefined) => /^hosting:/i.test(sku ?? "");

/**
 * Flip to true when provisioning queues one hosting request per hosting line (board R-032,
 * Abhishek). Checkout already takes a domain for each plan and puts it on that plan's line as
 * `hostingDomain` (30 Sep 2026); this switch is the only thing still keeping a second plan out.
 * Turning it on before R-032 lands charges for accounts that are never set up.
 */
export const SEVERAL_HOSTING_PLANS_READY = true; // R-032 landed, 1 Oct 2026

/** What makes the order too big, or null when it holds at most one hosting account. */
function tooManyHosting(lines: HostingLimitLine[], ready: boolean = SEVERAL_HOSTING_PLANS_READY): string | null {
  const hosting = lines.filter((l) => isHosting(l.sku));
  // Once several plans can be provisioned, only a quantity above 1 is still refused: one line
  // is one account on one domain, so two accounts are two lines, each with its own domain.
  if (ready) {
    const doubled = hosting.find((l) => l.qty > 1);
    return doubled ? `a hosting plan with quantity ${doubled.qty}` : null;
  }
  const accounts = hosting.reduce((n, l) => n + l.qty, 0);
  if (accounts <= 1) return null;
  return hosting.length > 1 ? `${hosting.length} hosting plans` : `a hosting plan with quantity ${accounts}`;
}

/** A §7 message when the order holds more than one hosting account, otherwise null. */
export function hostingLimitProblem(lines: HostingLimitLine[], ready: boolean = SEVERAL_HOSTING_PLANS_READY): string | null {
  const why = tooManyHosting(lines, ready);
  if (!why) return null;
  if (ready) {
    return (
      `This order has ${why}. Each hosting account is set up on its own domain, so add the plan once for each ` +
      "website, with that website's domain. Nothing was charged."
    );
  }
  return (
    `This order has ${why}, and one order can set up only one hosting account for now. Nothing was charged. ` +
    "Keep one hosting plan (quantity 1) in the cart and check out, then place a separate order for the next one."
  );
}

/**
 * The same rule, said BEFORE the customer pays (30 Sep 2026). The refusal above used to be the
 * first thing anyone saw, after filling in checkout and pressing Pay. The cart, the cart drawer
 * and checkout's first step now say it as soon as the second plan goes in.
 */
export function hostingLimitWarning(lines: HostingLimitLine[], ready: boolean = SEVERAL_HOSTING_PLANS_READY): string | null {
  const why = tooManyHosting(lines, ready);
  if (!why) return null;
  if (ready) return `Your cart has ${why}. Add the plan once for each website instead, each with its own domain.`;
  return (
    `Your cart has ${why}. One order can set up only one hosting account for now, ` +
    "so keep one hosting plan (quantity 1) here and order the next one separately."
  );
}
