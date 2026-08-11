/**
 * Indian Cost to Company (CTC) Salary Breakdown Calculator Engine.
 *
 * Detailed Indian Corporate & Reseller HR CTC Breakdown Model:
 * 1. Monthly CTC = Annual CTC / 12
 * 2. Basic Salary = 50% of Monthly CTC
 * 3. House Rent Allowance (HRA) = 40% of Basic (Non-Metro) or 50% (Metro)
 * 4. Conveyance / Transport Allowance = ₹1,600/mo (Tax-exempt standard)
 * 5. Medical Allowance = ₹1,250/mo (Standard tax allowance)
 * 6. Employer EPF = 12% of Basic (capped at ₹1,800/mo)
 *    - Employer EPS (Pension Fund): 8.33% of Basic (capped at ₹1,250/mo)
 *    - Employer EPF Share: 3.67% of Basic (balance ₹550/mo)
 * 7. Employer ESI = 3.25% of Gross (only if Gross ≤ ₹21,000/mo)
 * 8. Gratuity Provision = 4.81% of Basic (15 days / 26 days per year)
 * 9. Special / Flexible Allowance = Monthly CTC - (Basic + HRA + Conveyance + Medical + Employer EPF + Employer ESI + Gratuity)
 * 10. Gross Salary = Basic + HRA + Conveyance + Medical + Special Allowance
 * 11. Employee EPF = 12% of Basic (capped at ₹1,800/mo)
 * 12. Employee ESI = 0.75% of Gross (only if Gross ≤ ₹21,000/mo)
 * 13. Professional Tax (PT) = ₹200/mo (Standard slab)
 * 14. Net Take Home = Gross Salary - (Employee EPF + Employee ESI + Professional Tax)
 */

export interface CtcBreakdown {
  annualCtc: number;
  monthlyCtc: number;

  // Earnings (Gross Components)
  basicMonthly: number;
  basicAnnual: number;
  hraMonthly: number;
  hraAnnual: number;
  conveyanceMonthly: number;
  conveyanceAnnual: number;
  medicalMonthly: number;
  medicalAnnual: number;
  specialAllowanceMonthly: number;
  specialAllowanceAnnual: number;
  grossMonthly: number;
  grossAnnual: number;

  // Employer Contributions (Included in CTC)
  employerPfMonthly: number; // Total 12% (₹1,800)
  employerEpsMonthly: number; // 8.33% (₹1,250)
  employerEpfShareMonthly: number; // 3.67% (₹550)
  employerPfAnnual: number;
  employerEsiMonthly: number;
  employerEsiAnnual: number;
  gratuityMonthly: number;
  gratuityAnnual: number;
  totalEmployerContributionMonthly: number;
  totalEmployerContributionAnnual: number;

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
    includeConveyanceMedical?: boolean;
  }
): CtcBreakdown {
  const isMetro = opts?.isMetro ?? false;
  const capPfWageCeiling = opts?.capPfWageCeiling ?? true;
  const includeGratuity = opts?.includeGratuity ?? true;
  const includeEsi = opts?.includeEsi ?? true;
  const includeConveyanceMedical = opts?.includeConveyanceMedical ?? true;

  const annualCtc = Math.max(0, Math.round(annualCtcInput));
  const monthlyCtc = Math.round(annualCtc / 12);

  // 1. Basic = 50% of Monthly CTC
  const basicMonthly = Math.round(monthlyCtc * 0.5);

  // 2. HRA = 40% of Basic (or 50% for Metro)
  const hraMonthly = Math.round(basicMonthly * (isMetro ? 0.5 : 0.4));

  // 3. Conveyance & Medical Allowances
  const conveyanceMonthly = includeConveyanceMedical && monthlyCtc >= 25000 ? 1600 : 0;
  const medicalMonthly = includeConveyanceMedical && monthlyCtc >= 25000 ? 1250 : 0;

  // 4. Employer PF (12% of Basic, capped at ₹1,800 if ceiling applies)
  let employerPfMonthly = Math.round(basicMonthly * 0.12);
  if (capPfWageCeiling && employerPfMonthly > 1800) {
    employerPfMonthly = 1800;
  }
  const employerEpsMonthly = Math.min(1250, Math.round(basicMonthly * 0.0833));
  const employerEpfShareMonthly = Math.max(0, employerPfMonthly - employerEpsMonthly);

  // 5. Gratuity (4.81% of Basic = 15/26 / 12)
  const gratuityMonthly = includeGratuity ? Math.round(basicMonthly * (15 / (26 * 12))) : 0;

  // Preliminary Gross to check ESI eligibility (Ceiling ₹21,000/mo)
  const prelimGross = basicMonthly + hraMonthly + conveyanceMonthly + medicalMonthly;
  const isEsiEligible = includeEsi && prelimGross <= 21000;
  const employerEsiMonthly = isEsiEligible ? Math.round(prelimGross * 0.0325) : 0;

  const totalEmployerContributionMonthly = employerPfMonthly + employerEsiMonthly + gratuityMonthly;

  // 6. Special Allowance = Monthly CTC - (Basic + HRA + Conveyance + Medical + Employer PF + Employer ESI + Gratuity)
  const sumFixedEmployerCost = basicMonthly + hraMonthly + conveyanceMonthly + medicalMonthly + totalEmployerContributionMonthly;
  const specialAllowanceMonthly = Math.max(0, monthlyCtc - sumFixedEmployerCost);

  // 7. Gross Monthly Salary = Basic + HRA + Conveyance + Medical + Special Allowance
  const grossMonthly = basicMonthly + hraMonthly + conveyanceMonthly + medicalMonthly + specialAllowanceMonthly;

  // 8. Employee Deductions
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
    conveyanceMonthly,
    conveyanceAnnual: conveyanceMonthly * 12,
    medicalMonthly,
    medicalAnnual: medicalMonthly * 12,
    specialAllowanceMonthly,
    specialAllowanceAnnual: specialAllowanceMonthly * 12,
    grossMonthly,
    grossAnnual: grossMonthly * 12,

    employerPfMonthly,
    employerEpsMonthly,
    employerEpfShareMonthly,
    employerPfAnnual: employerPfMonthly * 12,
    employerEsiMonthly,
    employerEsiAnnual: employerEsiMonthly * 12,
    gratuityMonthly,
    gratuityAnnual: gratuityMonthly * 12,
    totalEmployerContributionMonthly,
    totalEmployerContributionAnnual: totalEmployerContributionMonthly * 12,

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
