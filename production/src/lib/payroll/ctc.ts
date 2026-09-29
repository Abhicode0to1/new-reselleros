/**
 * Indian Cost to Company (CTC) Salary Breakdown Calculator Engine.
 * Supports standard Indian Wage Code calculations as well as 100% custom component overrides:
 * - Basic Salary (₹ or %)
 * - HRA Allowance (₹ or %)
 * - Conveyance Allowance (₹)
 * - Medical Allowance (₹)
 * - Special / Flexi Allowance (₹)
 * - Professional Tax (₹)
 * - Employer & Employee PF / ESI / Gratuity toggles
 *
 * The PF caps come from lib/payroll/pf.ts for the month in `opts.asOf` (₹15,000 wage
 * ceiling till Sep 2026, ₹25,000 from Oct 2026) — never a literal ₹1,800 / ₹1,250 here.
 */
import { pfWageCeiling, pfEpsCap, PF_EMPLOYEE_RATE, PF_EMPLOYER_RATE } from "./pf";

export interface CtcBreakdown {
  annualCtc: number;
  monthlyCtc: number;

  // Configuration percentages used
  basicPct: number;
  hraPct: number;

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
  employerPfMonthly: number; // Total 12% (capped or uncapped)
  employerEpsMonthly: number; // 8.33% (capped at 8.33% of the PF wage ceiling)
  employerEpfShareMonthly: number; // 3.67%
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
    basicPct?: number; // Custom basic percentage (e.g., 0.40, 0.50)
    hraPct?: number; // Custom HRA percentage (e.g., 0.40, 0.50)
    customBasicMonthly?: number; // Explicit Basic Salary in ₹
    customHraMonthly?: number; // Explicit HRA in ₹
    customConveyanceMonthly?: number; // Custom conveyance allowance
    customMedicalMonthly?: number; // Custom medical allowance
    customSpecialMonthly?: number; // Explicit Special Allowance in ₹
    customPtMonthly?: number; // Explicit Professional Tax in ₹
    capPfWageCeiling?: boolean; // Cap PF at the statutory wage ceiling for the month
    asOf?: string; // salary month (YYYY-MM) or date — picks the PF ceiling; default today
    includeGratuity?: boolean;
    includeEsi?: boolean;
  }
): CtcBreakdown {
  const isMetro = opts?.isMetro ?? false;
  const basicPct = opts?.basicPct ?? 0.5; // Default 50%
  const hraPct = opts?.hraPct ?? (isMetro ? 0.5 : 0.4); // Default 40% (non-metro) or 50% (metro)
  const capPfWageCeiling = opts?.capPfWageCeiling ?? true;
  const includeGratuity = opts?.includeGratuity ?? true;
  const includeEsi = opts?.includeEsi ?? true;
  const pfCeiling = pfWageCeiling(opts?.asOf);
  const pfCapMonthly = Math.round(pfCeiling * PF_EMPLOYER_RATE);

  const annualCtc = Math.max(0, Math.round(annualCtcInput));
  const monthlyCtc = Math.round(annualCtc / 12);

  // 1. Basic Salary (Custom ₹ override or % calculation)
  const basicMonthly = opts?.customBasicMonthly !== undefined && opts.customBasicMonthly > 0
    ? Math.round(opts.customBasicMonthly)
    : Math.round(monthlyCtc * basicPct);

  // 2. HRA (Custom ₹ override or % calculation)
  const hraMonthly = opts?.customHraMonthly !== undefined && opts.customHraMonthly > 0
    ? Math.round(opts.customHraMonthly)
    : Math.round(basicMonthly * hraPct);

  // 3. Conveyance & Medical Allowances
  const conveyanceMonthly = opts?.customConveyanceMonthly !== undefined
    ? Math.max(0, Math.round(opts.customConveyanceMonthly))
    : (monthlyCtc >= 25000 ? 1600 : 0);

  const medicalMonthly = opts?.customMedicalMonthly !== undefined
    ? Math.max(0, Math.round(opts.customMedicalMonthly))
    : (monthlyCtc >= 25000 ? 1250 : 0);

  // 4. Employer PF (12% of Basic, capped at 12% of the wage ceiling if the cap applies)
  let employerPfMonthly = Math.round(basicMonthly * PF_EMPLOYER_RATE);
  if (capPfWageCeiling && employerPfMonthly > pfCapMonthly) {
    employerPfMonthly = pfCapMonthly;
  }
  const employerEpsMonthly = Math.min(pfEpsCap(opts?.asOf), Math.round(basicMonthly * 0.0833));
  const employerEpfShareMonthly = Math.max(0, employerPfMonthly - employerEpsMonthly);

  // 5. Gratuity (4.81% of Basic = 15/26 / 12)
  const gratuityMonthly = includeGratuity ? Math.round(basicMonthly * (15 / (26 * 12))) : 0;

  // Preliminary Gross to check ESI eligibility (Ceiling ₹21,000/mo)
  const prelimGross = basicMonthly + hraMonthly + conveyanceMonthly + medicalMonthly;
  const isEsiEligible = includeEsi && prelimGross <= 21000;
  const employerEsiMonthly = isEsiEligible ? Math.round(prelimGross * 0.0325) : 0;

  const totalEmployerContributionMonthly = employerPfMonthly + employerEsiMonthly + gratuityMonthly;

  // 6. Special Allowance = Custom ₹ override or Monthly CTC - (Basic + HRA + Conveyance + Medical + Employer PF + Employer ESI + Gratuity)
  const sumFixedEmployerCost = basicMonthly + hraMonthly + conveyanceMonthly + medicalMonthly + totalEmployerContributionMonthly;
  const specialAllowanceMonthly = opts?.customSpecialMonthly !== undefined && opts.customSpecialMonthly >= 0
    ? Math.round(opts.customSpecialMonthly)
    : Math.max(0, monthlyCtc - sumFixedEmployerCost);

  // 7. Gross Monthly Salary = Basic + HRA + Conveyance + Medical + Special Allowance
  const grossMonthly = basicMonthly + hraMonthly + conveyanceMonthly + medicalMonthly + specialAllowanceMonthly;

  // 8. Employee Deductions
  let employeePfMonthly = Math.round(basicMonthly * PF_EMPLOYEE_RATE);
  if (capPfWageCeiling && employeePfMonthly > pfCapMonthly) {
    employeePfMonthly = pfCapMonthly;
  }

  const employeeEsiMonthly = isEsiEligible ? Math.round(grossMonthly * 0.0075) : 0;
  const professionalTaxMonthly = opts?.customPtMonthly !== undefined
    ? Math.max(0, Math.round(opts.customPtMonthly))
    : (grossMonthly > 15000 ? 200 : grossMonthly > 10000 ? 150 : 0);

  const totalDeductionsMonthly = employeePfMonthly + employeeEsiMonthly + professionalTaxMonthly;
  const netTakeHomeMonthly = Math.max(0, grossMonthly - totalDeductionsMonthly);

  return {
    annualCtc,
    monthlyCtc,

    basicPct,
    hraPct,

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
