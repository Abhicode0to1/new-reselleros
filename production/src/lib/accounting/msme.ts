/**
 * MSME (Udyam) vendors aur Income-tax s.43B(h) — pure helpers.
 *
 * s.43B(h) (FY 2023-24 se): micro ya small enterprise ko diya jaane wala paisa MSMED Act
 * s.15 ki meyaad me na chuke — likhit agreement ho to max 45 din, na ho to 15 din — to wo
 * kharcha us saal ke profit se nahi ghatta; jis saal chukaya, us saal ghatta hai. Medium
 * enterprise par ye niyam nahi lagta. Report (msme_payables_aging) 45 din par flag karta
 * hai; bina agreement wale vendor ke liye 15 din ki baat screen par likhi hai.
 */

/** Udyam Registration Number: UDYAM-<state 2>-<district 2 digits>-<7 digits>. DB check jaisa hi. */
export const UDYAM_RE = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;

export const MSME_LIMIT_DAYS = 45;
export const MSME_LIMIT_DAYS_NO_AGREEMENT = 15;

export function isUdyam(v: string | null | undefined): boolean {
  return UDYAM_RE.test((v ?? "").trim().toUpperCase());
}

/** Aging rows ka saar: kitna bakaya, kitna 45 din paar (jo is FY ka deduction rok sakta hai). */
export function msmeSummary(rows: readonly { amount_due: number; over_limit: boolean; vendor_id: string }[]) {
  const over = rows.filter((r) => r.over_limit);
  return {
    due: rows.reduce((s, r) => s + r.amount_due, 0),
    overDue: over.reduce((s, r) => s + r.amount_due, 0),
    overCount: over.length,
    vendorsOver: new Set(over.map((r) => r.vendor_id)).size,
  };
}
