/**
 * Indian Cost to Company (CTC) Salary Breakdown Calculator Engine.
 *
 * Standard Indian Corporate & Reseller HR CTC Breakdown Model:
 * 1. Monthly CTC = Annual CTC / 12
 * 2. Basic Salary = 50% of Monthly CTC (per New Wage Code recommendations)
 * 3. House Rent Allowance (HRA) = 40% of Basic (Non-Metro) or 50% (Metro)
 * 4. Employer EPF = 12% of Basic (capped at ₹1,800/mo if PF statutory ceiling applies)
 * 5. Employer ESI = 3.25% of Gross (only if Gross ≤ ₹21,000/mo)
 * 6. Gratuity Provision = 4.81% of Basic (15 days / 26 days per year)
 * 7. Special / Flexible Allowance = Monthly CTC - (Basic + HRA + Employer EPF + Employer ESI + Gratuity)
 * 8. Gross Salary = Basic + HRA + Special Allowance
 * 9. Employee EPF = 12% of Basic (capped at ₹1,800/mo)
 * 10. Employee ESI = 0.75% of Gross (only if Gross ≤ ₹21,000/mo)
 * 11. Professional Tax (PT) = ₹200/mo (Standard slab)
 * 12. Net Take Home = Gross Salary - (Employee EPF + Employee ESI + Professional Tax)
 */

export interface CtcBreakdown {
  annualCtc: number;
  monthlyCtc: number;

  // Earnings (Gross Component)
  basicMonthly: number;
  basicAnnual: number;
  hraMonthly: number;
  hraAnnual: number;
  specialAllowanceMonthly: number;
  specialAllowanceAnnual: number;
  grossMonthly: number;
  grossAnnual: number;

  // Employer Contributions (Included in CTC)
  employerPfMonthly: number;
  employerPfAnnual: number;
  employerEsiMonthly: number;
  employerEsiAnnual: number;
  gratuityMonthly: number;
  gratuityAnnual: number;

  // Employee Deductions (Subtracted from Gross)
  employeePfMonthly: number;
  employeePfAnnual: number;
  employeeEsiMonthly: number;
  employeeEsiAnnual: number;
  professionalTaxMonthly: number;
  professionalTaxAnnual: number;
  totalDeductionsMonthly: number;
  totalDeductionsAnnual: number;

  // Final In-Hand / Take Home
  netTakeHomeMonthly: number;
  netTakeHomeAnnual: number;
}

export function calculateCtcBreakdown(
  annualCtcInput: number,
  opts?: {
    isMetro?: boolean;
    capPfWageCeiling?: boolean; // Cap PF to ₹1,800/mo (₹15,000 basic limit)
    includeGratuity?: boolean;
    includeEsi?: boolean;
  }
): CtcBreakdown {
  const isMetro = opts?.isMetro ?? false;
  const capPfWageCeiling = opts?.capPfWageCeiling ?? true;
  const includeGratuity = opts?.includeGratuity ?? true;
  const includeEsi = opts?.includeEsi ?? true;

  const annualCtc = Math.max(0, Math.round(annualCtcInput));
  const monthlyCtc = Math.round(annualCtc / 12);

  // 1. Basic = 50% of Monthly CTC
  const basicMonthly = Math.round(monthlyCtc * 0.5);

  // 2. HRA = 40% of Basic (or 50% for Metro)
  const hraMonthly = Math.round(basicMonthly * (isMetro ? 0.5 : 0.4));

  // 3. Employer PF (12% of Basic, capped at ₹1,800 if ceiling applies)
  let employerPfMonthly = Math.round(basicMonthly * 0.12);
  if (capPfWageCeiling && employerPfMonthly > 1800) {
    employerPfMonthly = 1800;
  }

  // 4. Gratuity (4.81% of Basic = 15/26 / 12)
  const gratuityMonthly = includeGratuity ? Math.round(basicMonthly * (15 / (26 * 12))) : 0;

  // Preliminary Gross to check ESI eligibility (Ceiling ₹21,000/mo)
  const prelimGross = basicMonthly + hraMonthly;
  const isEsiEligible = includeEsi && prelimGross <= 21000;
  const employerEsiMonthly = isEsiEligible ? Math.round(prelimGross * 0.0325) : 0;

  // 5. Special Allowance = Monthly CTC - (Basic + HRA + Employer PF + Employer ESI + Gratuity)
  const sumFixedEmployerCost = basicMonthly + hraMonthly + employerPfMonthly + employerEsiMonthly + gratuityMonthly;
  const specialAllowanceMonthly = Math.max(0, monthlyCtc - sumFixedEmployerCost);

  // 6. Gross Monthly Salary = Basic + HRA + Special Allowance
  const grossMonthly = basicMonthly + hraMonthly + specialAllowanceMonthly;

  // 7. Employee Deductions
  let employeePfMonthly = Math.round(basicMonthly * 0.12);
  if (capPfWageCeiling && employeePfMonthly > 1800) {
    employeePfMonthly = 1800;
  }

  const employeeEsiMonthly = isEsiEligible ? Math.round(grossMonthly * 0.0075) : 0;
  const professionalTaxMonthly = grossMonthly > 15000 ? 200 : grossMonthly > 10000 ? 150 : 0;

  const totalDeductionsMonthly = employeePfMonthly + employeeEsiMonthly + professionalTaxMonthly;
  const netTakeHomeMonthly = Math.max(0, grossMonthly - totalDeductionsMonthly);

  return {
    annualCtc,
    monthlyCtc,

    basicMonthly,
    basicAnnual: basicMonthly * 12,
    hraMonthly,
    hraAnnual: hraMonthly * 12,
    specialAllowanceMonthly,
    specialAllowanceAnnual: specialAllowanceMonthly * 12,
    grossMonthly,
    grossAnnual: grossMonthly * 12,

    employerPfMonthly,
    employerPfAnnual: employerPfMonthly * 12,
    employerEsiMonthly,
    employerEsiAnnual: employerEsiMonthly * 12,
    gratuityMonthly,
    gratuityAnnual: gratuityMonthly * 12,

    employeePfMonthly,
    employeePfAnnual: employeePfMonthly * 12,
    employeeEsiMonthly,
    employeeEsiAnnual: employeeEsiMonthly * 12,
    professionalTaxMonthly,
    professionalTaxAnnual: professionalTaxMonthly * 12,
    totalDeductionsMonthly,
    totalDeductionsAnnual: totalDeductionsMonthly * 12,

    netTakeHomeMonthly,
    netTakeHomeAnnual: netTakeHomeMonthly * 12,
  };
}
