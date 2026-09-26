/**
 * How a salary record's net was reached — the lines Payroll's pay_salary adds up:
 *
 *   gross − LOP + incentive = earned
 *   earned − advance recovered − TDS − PF − ESI − other deductions = net
 *
 * "₹5,35,000" on the payroll row said nothing about being ₹35,000 salary + ₹5,00,000 deal
 * incentive. These are the same fields pay_salary stored, so the lines always add up to the
 * net on the row; employer PF / ESI are shown apart — a cost to the company, not deducted.
 */

export interface SalaryRecordLike {
  gross: number;
  lop_days?: number | null;
  lop_amount?: number | null;
  incentive?: number | null;
  advance_recovered?: number | null;
  tds?: number | null;
  pf?: number | null;
  esi?: number | null;
  other_deduction?: number | null;
  net: number;
  pf_employer?: number | null;
  esi_employer?: number | null;
}

export interface BreakdownLine { label: string; amount: number; sign: "+" | "−" | "="; note?: string }

export function salaryBreakdown(p: SalaryRecordLike): { lines: BreakdownLine[]; earned: number; addsUp: boolean; employerCost: number } {
  const n = (v: number | null | undefined) => Math.max(0, Math.round(v ?? 0));
  const lines: BreakdownLine[] = [{ label: "Monthly salary (gross)", amount: n(p.gross), sign: "+" }];
  if (n(p.lop_amount) > 0) lines.push({ label: "Loss of pay", amount: n(p.lop_amount), sign: "−", note: `${p.lop_days ?? 0} din` });
  if (n(p.incentive) > 0) lines.push({ label: "Incentive / commission", amount: n(p.incentive), sign: "+" });
  const earned = n(p.gross) - n(p.lop_amount) + n(p.incentive);
  lines.push({ label: "Earned", amount: earned, sign: "=" });
  const deductions: [string, number | null | undefined][] = [
    ["Advance recovered", p.advance_recovered], ["TDS (192)", p.tds], ["PF (employee)", p.pf],
    ["ESI (employee)", p.esi], ["Other deductions", p.other_deduction],
  ];
  for (const [label, v] of deductions) if (n(v) > 0) lines.push({ label, amount: n(v), sign: "−" });
  const computedNet = earned - deductions.reduce((s, [, v]) => s + n(v), 0);
  lines.push({ label: "Net pay", amount: n(p.net), sign: "=" });
  return { lines, earned, addsUp: computedNet === n(p.net), employerCost: n(p.pf_employer) + n(p.esi_employer) };
}
