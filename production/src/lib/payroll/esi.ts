/**
 * ESI (Employees' State Insurance) — statutory wage contribution.
 *
 * SINGLE SOURCE OF TRUTH for ESI rates + applicability. If the government
 * revises rates or the wage ceiling, change them HERE only — the pay-salary
 * form, the ESI register and any report all read from this module.
 *
 * Rules (current, since 1 Jul 2019):
 *   • Applies only when monthly gross wages ≤ ₹21,000 (the wage ceiling).
 *   • Employee contributes 0.75% of wages; employer contributes 3.25%.
 *   • Each share is rounded UP to the next rupee (ESIC rounding rule).
 *   • The monthly ESIC challan the employer pays = employee + employer share.
 *   • Due by the 15th of the following month.
 *
 * NOTE on contribution period: once an employee is covered at the start of a
 * contribution period (Apr–Sep / Oct–Mar) they stay covered till its end even
 * if wages later cross the ceiling. v1 checks month-by-month for simplicity;
 * the caller can force coverage via `covered`.
 */

export const ESI_WAGE_CEILING = 21_000; // ₹/month gross — ESI applies at or below this
export const ESI_EMPLOYEE_RATE = 0.0075; // 0.75%
export const ESI_EMPLOYER_RATE = 0.0325; // 3.25%

export interface EsiContribution {
  applicable: boolean;
  base: number; // the wage the percentages apply to (₹)
  employee: number; // employee share, 0.75%, rounded up (₹)
  employer: number; // employer share, 3.25%, rounded up (₹)
  total: number; // employee + employer = the ESIC challan portion (₹)
}

const ZERO = (base: number): EsiContribution => ({
  applicable: false,
  base,
  employee: 0,
  employer: 0,
  total: 0,
});

/**
 * Compute the ESI split for a month's wage.
 * @param monthlyWage the gross wage for the month (₹, integer)
 * @param covered     pass false to force-exclude an exempt employee even if
 *                    they are under the wage ceiling. Defaults to true.
 */
/**
 * ESI contribution periods: Apr–Sep and Oct–Mar. Once an employee is covered in a
 * period they stay covered to its end even if wages cross ₹21,000 (ESI Act s.2(9)
 * proviso) — the wage test is applied at the START of the period, not every month.
 */
export function esiContributionPeriodStart(period: string): string {
  const [y, m] = period.slice(0, 7).split("-").map(Number);
  return m >= 4 && m <= 9 ? `${y}-04` : m >= 10 ? `${y}-10` : `${y - 1}-10`;
}

/** Was this employee already contributing earlier in the same contribution period?
 *  `earlier` = the employee's payslips (period + employee ESI). */
export function esiStickyCovered(period: string, earlier: { period: string; esi?: number | null }[]): boolean {
  const start = esiContributionPeriodStart(period);
  return earlier.some((p) => p.period >= start && p.period < period.slice(0, 7) && (p.esi ?? 0) > 0);
}

/**
 * Compute the ESI split for a month's wage.
 * @param monthlyWage the gross wage for the month (₹, integer)
 * @param covered     pass false to force-exclude an exempt employee even if
 *                    they are under the wage ceiling. Defaults to true.
 * @param sticky      true when the employee was already covered earlier in this
 *                    contribution period — the ceiling is then ignored (esiStickyCovered).
 */
export function computeEsi(monthlyWage: number, covered = true, sticky = false): EsiContribution {
  const base = Math.max(0, Math.round(monthlyWage || 0));
  if (!covered || base <= 0 || (base > ESI_WAGE_CEILING && !sticky)) return ZERO(base);
  const employee = Math.ceil(base * ESI_EMPLOYEE_RATE);
  const employer = Math.ceil(base * ESI_EMPLOYER_RATE);
  return { applicable: true, base, employee, employer, total: employee + employer };
}

/** Wage-ceiling test only — is this gross low enough for ESI to apply at all? */
export function isEsiEligible(monthlyGross: number): boolean {
  const g = monthlyGross || 0;
  return g > 0 && g <= ESI_WAGE_CEILING;
}
