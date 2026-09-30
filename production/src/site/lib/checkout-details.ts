/**
 * What the checkout form still needs before it can go on — as words a buyer can act on.
 *
 * Until 29 Sep 2026 the buttons were simply disabled while anything was missing, and a
 * disabled .btn-primary looks exactly like an enabled one. The owner pressed "Start my
 * 15-day free trial" with the (then required) company name blank and nothing happened, with
 * nothing on screen to say why. Now the button always responds: if something is missing it
 * says exactly what (AGENTS.md §7: what happened, why, what to do next).
 *
 * The company name is optional (owner, same day); the server uses the buyer's own name.
 * These rules must stay in step with `cartSchema` in lib/checkout/cart-checkout.ts.
 */
export interface CheckoutDetails {
  name: string;
  email: string;
  phone: string;
  domain: string;
  hasHosting: boolean;
  hasDomain: boolean;
  address: { line1: string; city: string; state: string; pin: string };
}

export function missingCheckoutDetails(d: CheckoutDetails): string[] {
  const missing: string[] = [];
  if (d.name.trim().length < 2) missing.push("your name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) missing.push("a valid email address");
  if (d.phone.replace(/\D/g, "").length < 10) missing.push("your mobile number (10 digits)");
  if (d.hasHosting && d.domain.trim().length < 3) missing.push("the domain for your hosting");
  if (d.hasDomain) {
    const a = d.address;
    if (a.line1.trim().length < 3 || a.city.trim().length < 2 || a.state.trim().length < 2 || !/^\d{6}$/.test(a.pin.trim())) {
      missing.push("the domain owner's postal address (address, city, state and a 6-digit PIN code)");
    }
  }
  return missing;
}

/** "Please add your name and your mobile number (10 digits) to continue." */
export function missingDetailsMessage(missing: string[]): string | null {
  if (missing.length === 0) return null;
  const list = missing.length === 1
    ? missing[0]
    : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  return `Please add ${list} to continue.`;
}
