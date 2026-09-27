/**
 * "2026-07" → "July 2026".
 *
 * Lives here, not in lib/pdf/PayslipPDF.tsx, on purpose: the payroll screen imported it
 * from there, which statically pulled @react-pdf/renderer (1 MB+) into the client bundle
 * and undid the dynamic-import pattern in lib/pdf/index.tsx (deep study, 27 Sep 2026).
 */
export function periodLabel(period: string): string {
  const [yy, mm] = period.split("-").map(Number);
  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  if (!yy || !mm || mm < 1 || mm > 12) return period;
  return `${MONTHS[mm - 1]} ${yy}`;
}
