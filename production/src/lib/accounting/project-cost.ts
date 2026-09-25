/**
 * Project delivery cost — the salary spent building a customer's software, moved out of
 * operating expenses and into cost of goods, where it belongs.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * A developer's salary while they build a customer's project is the cost of THAT sale,
 * exactly as a Google licence is the cost of a Workspace sale. Left in "Operating
 * expenses" it makes every project look like 100% gross margin and every month look like
 * overhead. The project page already records who worked on what (`project_labour`:
 * employee, % of their time, months, dates); the company P&L simply never read it.
 *
 * ─── IT IS A RECLASSIFICATION, NEVER AN ADDITION ────────────────────────────
 * Salaries are booked once, as `expenses` rows. Whatever this module puts into cost of
 * goods is taken OUT of operating expenses by the same amount — net profit does not move
 * by a rupee. And it can never move more than was actually booked as salary in the
 * period: an allocation says "60% of Ranjeet's time", not "the company paid ₹21,000 this
 * month". If payroll for the period is not booked yet, the allocation is capped to what
 * is, and the cap is reported rather than hidden.
 *
 * ─── WHAT COUNTS ────────────────────────────────────────────────────────────
 * - Labour: employees.monthly_gross × percent% × the months of that allocation falling
 *   inside the period. An allocation runs from its start_date (else the project's) to its
 *   end_date (else start + `months`). With no date at all it cannot be placed in any
 *   period, so it is counted as UNDATED and left out — never spread by guess.
 * - Direct costs: any expense tagged with a project_id (hosting, a freelancer, a tool
 *   bought for that client). Those are cost of goods whatever their category.
 *
 * Whole rupees in and out; rounded once per allocation line.
 */
import { monthsActiveInPeriod } from "./pnl";

/** Expense categories that are payroll — the pool labour can be moved out of. */
export const SALARY_CATEGORIES: ReadonlySet<string> = new Set(["Salaries", "Director's Remuneration"]);

export interface LabourAllocation {
  project_id: string;
  employee_id: string;
  percent: number;
  months: number;
  start_date: string | null;
  end_date: string | null;
}

export interface ProjectInfo {
  id: string;
  title: string;
  customer_name: string | null;
  start_date: string | null;
}

export interface CostExpense {
  amount: number | null;
  category: string | null;
  project_id: string | null;
}

export interface ProjectRevenue {
  project_id: string;
  /** ₹ taxable value invoiced in the period against this project's milestones. */
  revenue: number;
}

export interface ProjectCostLine {
  projectId: string;
  title: string;
  customerName: string | null;
  revenue: number;
  labour: number;
  direct: number;
  /** revenue − labour − direct. */
  margin: number;
  /** Integer % of revenue; null when there is no revenue in the period. */
  marginPct: number | null;
}

export interface ProjectCostResult {
  /** Labour actually moved into cost of goods (after the cap). */
  labour: number;
  /** Project-tagged expenses in the period. */
  direct: number;
  /** labour + direct — the project part of cost of goods. */
  total: number;
  /** Labour the allocations asked for, before the cap. */
  labourAllocated: number;
  /** True when allocations exceeded the salary actually booked, so labour was scaled down. */
  capped: boolean;
  /** Salary booked in the period that labour could be taken from. */
  salaryPool: number;
  /** Allocations with no date anywhere — cannot be placed in a period. */
  undated: number;
  byProject: ProjectCostLine[];
}

/** YYYY-MM-DD + n months − 1 day: the last day of an allocation `months` long. */
export function allocationEnd(start: string, months: number): string {
  const d = new Date(`${start.slice(0, 10)}T00:00:00Z`);
  const whole = Math.floor(months);
  const extraDays = Math.round((months - whole) * 30.44);
  d.setUTCMonth(d.getUTCMonth() + whole);
  d.setUTCDate(d.getUTCDate() + extraDays - 1);
  return d.toISOString().slice(0, 10);
}

export function projectCostForPeriod(input: {
  from: string;
  to: string;
  allocations: readonly LabourAllocation[];
  monthlyGross: ReadonlyMap<string, number>;
  projects: readonly ProjectInfo[];
  /** Every expense dated in the period. */
  expenses: readonly CostExpense[];
  revenueByProject?: readonly ProjectRevenue[];
}): ProjectCostResult {
  const projectById = new Map(input.projects.map((p) => [p.id, p]));

  /* The pool: salary booked in the period that is not already tagged to a project (a
     tagged salary row is a direct cost already, and must not be moved twice). */
  const salaryPool = input.expenses
    .filter((e) => !e.project_id && SALARY_CATEGORIES.has(e.category ?? ""))
    .reduce((s, e) => s + (e.amount ?? 0), 0);

  const directBy = new Map<string, number>();
  for (const e of input.expenses) {
    if (!e.project_id) continue;
    directBy.set(e.project_id, (directBy.get(e.project_id) ?? 0) + (e.amount ?? 0));
  }

  const rawLabourBy = new Map<string, number>();
  let undated = 0;
  for (const a of input.allocations) {
    const start = a.start_date ?? projectById.get(a.project_id)?.start_date ?? null;
    if (!start) { undated += 1; continue; }
    const end = a.end_date ?? allocationEnd(start, a.months);
    const months = monthsActiveInPeriod({ startDate: start, renewalDate: end }, input.from, input.to);
    if (months <= 0) continue;
    const cost = Math.round((input.monthlyGross.get(a.employee_id) ?? 0) * (a.percent / 100) * months);
    if (cost > 0) rawLabourBy.set(a.project_id, (rawLabourBy.get(a.project_id) ?? 0) + cost);
  }

  const labourAllocated = [...rawLabourBy.values()].reduce((s, v) => s + v, 0);
  const capped = labourAllocated > salaryPool;
  const scale = capped ? (labourAllocated > 0 ? salaryPool / labourAllocated : 0) : 1;

  /* Scale each project, then give any rounding remainder to the largest, so the lines add
     up to exactly the pool — a cost of goods that disagrees with its own breakdown by ₹1
     is the kind of thing a CA circles. */
  const labourBy = new Map<string, number>();
  for (const [id, v] of rawLabourBy) labourBy.set(id, Math.round(v * scale));
  const labour = capped ? salaryPool : labourAllocated;
  const drift = labour - [...labourBy.values()].reduce((s, v) => s + v, 0);
  if (drift !== 0 && labourBy.size > 0) {
    const [bigId] = [...labourBy.entries()].sort((x, y) => y[1] - x[1])[0];
    labourBy.set(bigId, (labourBy.get(bigId) ?? 0) + drift);
  }

  const revenueBy = new Map((input.revenueByProject ?? []).map((r) => [r.project_id, r.revenue]));
  const ids = new Set([...labourBy.keys(), ...directBy.keys(), ...revenueBy.keys()]);
  const byProject: ProjectCostLine[] = [...ids].map((id) => {
    const p = projectById.get(id);
    const revenue = revenueBy.get(id) ?? 0;
    const l = labourBy.get(id) ?? 0;
    const d = directBy.get(id) ?? 0;
    const margin = revenue - l - d;
    return {
      projectId: id,
      title: p?.title ?? "Unknown project",
      customerName: p?.customer_name ?? null,
      revenue, labour: l, direct: d, margin,
      marginPct: revenue > 0 ? Math.round((margin / revenue) * 100) : null,
    };
  }).sort((a, b) => b.revenue - a.revenue || (b.labour + b.direct) - (a.labour + a.direct));

  const direct = [...directBy.values()].reduce((s, v) => s + v, 0);
  return {
    labour, direct, total: labour + direct,
    labourAllocated, capped, salaryPool, undated, byProject,
  };
}
