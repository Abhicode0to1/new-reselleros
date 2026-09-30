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

/** What makes the order too big, or null when it holds at most one hosting account. */
function tooManyHosting(lines: HostingLimitLine[]): string | null {
  const hosting = lines.filter((l) => isHosting(l.sku));
  const accounts = hosting.reduce((n, l) => n + l.qty, 0);
  if (accounts <= 1) return null;
  return hosting.length > 1 ? `${hosting.length} hosting plans` : `a hosting plan with quantity ${accounts}`;
}

/** A §7 message when the order holds more than one hosting account, otherwise null. */
export function hostingLimitProblem(lines: HostingLimitLine[]): string | null {
  const why = tooManyHosting(lines);
  if (!why) return null;
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
export function hostingLimitWarning(lines: HostingLimitLine[]): string | null {
  const why = tooManyHosting(lines);
  if (!why) return null;
  return (
    `Your cart has ${why}. One order can set up only one hosting account for now, ` +
    "so keep one hosting plan (quantity 1) here and order the next one separately."
  );
}
