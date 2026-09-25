/**
 * The payee named in a bank narration, for prefilling "Vendor / payee".
 *
 * Indian bank rails write the counterparty in a fixed slot:
 *   IMPS-<ref>-<NAME>-<bank>-<account>-<remark>     IMPS-612256087508-PRASHANT BHAIYA-FINO-XXXX6722-…
 *   NEFT-<ref>-<NAME>-…  /  RTGS-<ref>-<NAME>-…
 *   UPI/<ref>/<NAME>/<vpa>/…   (also UPI-…)
 * Anything else returns null — a guessed payee on an expense is worse than a blank one.
 */

const isName = (s: string | undefined): s is string =>
  !!s && /^[A-Za-z][A-Za-z .&']*[A-Za-z.]$/.test(s.trim()) && s.trim().length >= 3;

const titleCase = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());

export function payeeFromNarration(description: string | null | undefined): string | null {
  const text = (description ?? "").trim();
  if (!text) return null;

  const dash = text.split("-").map((s) => s.trim());
  if (/^(IMPS|NEFT|RTGS)$/i.test(dash[0] ?? "") && isName(dash[2])) return titleCase(dash[2]);

  const slash = text.split("/").map((s) => s.trim());
  if (/^UPI$/i.test(slash[0] ?? "") && isName(slash[2])) return titleCase(slash[2]);
  if (/^UPI$/i.test(dash[0] ?? "") && isName(dash[2])) return titleCase(dash[2]);

  return null;
}

/** A debit this small is almost always a test / account-verification ("penny drop") transfer. */
export const TEST_TRANSFER_MAX = 10;
