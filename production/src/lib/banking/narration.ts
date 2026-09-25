/**
 * The payee named in a bank narration, for prefilling "Vendor / payee".
 *
 * Indian bank rails write the counterparty in a fixed slot:
 *   IMPS-<ref>-<NAME>-<bank>-<account>-<remark>        IMPS-612256087508-PRASHANT BHAIYA-FINO-XXXX6722-…
 *   NEFT DR-<IFSC>-<NAME>-NETBANK, MUM-<utr>-<remark>  NEFT DR-BKID0006087-PRATIK-NETBANK, MUM-…
 *   NEFT-<ref>-<NAME>-…  /  RTGS DR-<IFSC>-<NAME>-…
 *   UPI/<ref>/<NAME>/<vpa>/…   (also UPI-…)
 * Card / net-banking payments through a gateway carry the MERCHANT glued to the
 * gateway's code after the last "/":
 *   KYQX244FAR4KPNGVCU/PAYUAMAZON   DHFISM1TU2WOC/BILLDKGOOGLECLOUD   …/PAYAMAZON
 * Anything else returns null — a guessed payee on an expense is worse than a blank one.
 */

const isName = (s: string | undefined): s is string =>
  !!s && /^[A-Za-z][A-Za-z .&']*[A-Za-z.]$/.test(s.trim()) && s.trim().length >= 3;

const titleCase = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());

/* Gateway codes that prefix the merchant, longest first so "PAYU" wins over "PAY". */
const GATEWAYS = ["RAZORPAY", "CCAVENUE", "CASHFREE", "BILLDESK", "BILLDK", "PAYTM", "RAZP", "CCAV", "PAYU", "PAY"];

/* Merchant codes as banks truncate them, and the name an operator would write. */
const MERCHANTS: Array<[RegExp, string]> = [
  [/^PLAYSTOREGOOGL|^GOOGLEPLAY/, "Google Play"],
  [/^GOOGLECLOUD|^GOOGLECLOU/, "Google Cloud"],
  [/^GOOGLEADS|^GOOGLE\*?ADS/, "Google Ads"],
  [/^GOOGLE/, "Google"],
  [/^FACEBOOK|^FACEBK|^META/, "Facebook"],
  [/^AMAZONWEBSERVICES|^AWS/, "Amazon Web Services"],
  [/^AMAZON|^AMZN/, "Amazon"],
  [/^MICROSOFT|^MSFT/, "Microsoft"],
  [/^FLIPKART/, "Flipkart"],
  [/^SWIGGY/, "Swiggy"],
  [/^ZOMATO/, "Zomato"],
  [/^UBER/, "Uber"],
];

function merchantFromGateway(text: string): string | null {
  const tail = text.split("/").pop()?.trim().toUpperCase() ?? "";
  if (!tail || tail === text.trim().toUpperCase()) return null;   // no "/" at all
  const gw = GATEWAYS.find((g) => tail.startsWith(g) && tail.length > g.length);
  if (!gw) return null;
  const code = tail.slice(gw.length).replace(/[^A-Z]/g, "");
  if (code.length < 3) return null;
  for (const [re, name] of MERCHANTS) if (re.test(code)) return name;
  return titleCase(code);
}

export function payeeFromNarration(description: string | null | undefined): string | null {
  const text = (description ?? "").trim();
  if (!text) return null;

  const dash = text.split("-").map((s) => s.trim());
  // "IMPS", "NEFT", "NEFT DR", "RTGS CR" … — the name sits in the third slot either way.
  if (/^(IMPS|NEFT|RTGS)(\s+(DR|CR))?$/i.test(dash[0] ?? "") && isName(dash[2])) return titleCase(dash[2]);

  const slash = text.split("/").map((s) => s.trim());
  if (/^UPI$/i.test(slash[0] ?? "") && isName(slash[2])) return titleCase(slash[2]);
  if (/^UPI$/i.test(dash[0] ?? "") && isName(dash[2])) return titleCase(dash[2]);

  return merchantFromGateway(text);
}

/** A debit this small is almost always a test / account-verification ("penny drop") transfer. */
export const TEST_TRANSFER_MAX = 10;
