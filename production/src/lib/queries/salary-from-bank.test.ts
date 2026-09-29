import { describe, it, expect } from "vitest";
import { bookSalaryGroups, type SalaryGroupInput } from "./salary-from-bank";

/**
 * A tiny in-memory stand-in for the Supabase client — just the calls bookSalaryGroups
 * makes. It records every employee insert, every pay_salary and every reconcile, so the
 * tests can count them.
 */
function fakeSupabase(opts: { existing?: Array<{ employee_id: string; period: string; id: string; net: number; paid_amount: number; paid_status: string }> } = {}) {
  const employees: Array<{ id: string; name: string }> = [];
  const salaries = [...(opts.existing ?? [])];
  const reconciles: Array<{ txn: string; salary: string }> = [];
  const paySalaryCalls: Array<Record<string, unknown>> = [];
  let n = 0;

  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const q = {
      insert(row: { name: string }) {
        const id = `emp-${++n}`;
        employees.push({ id, name: row.name });
        return { select: () => ({ single: async () => ({ data: { id }, error: null }) }) };
      },
      select() { return q; },
      eq(col: string, val: unknown) { filters[col] = val; return q; },
      async single() {
        if (table === "users") return { data: { tenant_id: "t1" }, error: null };
        if (table === "employees") return { data: employees.find((e) => e.id === filters.id) ?? null, error: null };
        const s = salaries.find((x) => x.employee_id === filters.employee_id && x.period === filters.period);
        return { data: s ?? null, error: s ? null : { message: "not found" } };
      },
      async maybeSingle() {
        const s = salaries.find((x) => x.employee_id === filters.employee_id && x.period === filters.period);
        return { data: s ?? null, error: null };
      },
    };
    return q;
  };

  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "pay_salary") {
        paySalaryCalls.push(args);
        salaries.push({ id: `sal-${++n}`, employee_id: args.p_employee_id as string, period: args.p_period as string, net: args.p_gross as number, paid_amount: 0, paid_status: "unpaid" });
      } else if (fn === "reconcile_bank_txn") {
        reconciles.push({ txn: args.p_txn_id as string, salary: args.p_matched_to_id as string });
      }
      return { error: null };
    },
  };
  return { client: client as never, employees, salaries, reconciles, paySalaryCalls };
}

const line = (txnId: string, amount: number) => ({ txnId, txnDate: "2026-05-12", amount, description: txnId });

describe("bookSalaryGroups", () => {
  it("creates a new employee ONCE across several months", async () => {
    const db = fakeSupabase();
    const groups: SalaryGroupInput[] = [
      { employee: { createName: "Ranjeet Raj", monthlyGross: 31000 }, period: "2026-04", lines: [line("t1", 31000)] },
      { employee: { createName: "Ranjeet Raj", monthlyGross: 31000 }, period: "2026-05", lines: [line("t2", 31000)] },
      { employee: { createName: "RANJEET RAJ", monthlyGross: 35000 }, period: "2026-08", lines: [line("t3", 35000)] },
    ];
    const res = await bookSalaryGroups(db.client, "acc", groups);

    expect(res.every((r) => r.ok)).toBe(true);
    expect(db.employees).toHaveLength(1);
    expect(new Set(db.salaries.map((s) => s.employee_id))).toEqual(new Set([db.employees[0].id]));
    expect(db.salaries.map((s) => s.period)).toEqual(["2026-04", "2026-05", "2026-08"]);
    expect(db.reconciles).toHaveLength(3);
  });

  it("a name the statement split differently is still one employee (26 Sep 2026: 15 for 8 people)", async () => {
    const db = fakeSupabase();
    const res = await bookSalaryGroups(db.client, "acc", [
      { employee: { createName: "Hitesh Babu", monthlyGross: 52000 }, period: "2026-05", lines: [line("h1", 52000)] },
      { employee: { createName: "Hitesh Ba Bu", monthlyGross: 52000 }, period: "2026-07", lines: [line("h2", 52000)] },
      { employee: { createName: "Hites H Babu", monthlyGross: 52000 }, period: "2026-08", lines: [line("h3", 52000)] },
    ]);
    expect(res.every((r) => r.ok)).toBe(true);
    expect(db.employees).toHaveLength(1);
    expect(db.salaries).toHaveLength(3);
  });

  it("a salary + commission transfer books the monthly salary as gross and the rest as incentive", async () => {
    const db = fakeSupabase();
    const res = await bookSalaryGroups(db.client, "acc", [
      { employee: { createName: "Abhishek", monthlyGross: 35000 }, period: "2026-06", lines: [line("a6", 70000)], incentive: 35000 },
    ]);
    expect(res[0].ok).toBe(true);
    expect(db.paySalaryCalls[0]).toMatchObject({ p_gross: 35000, p_incentive: 35000 });
    expect(db.reconciles).toHaveLength(1);
  });

  it("an incentive as large as the transfer is refused — nothing is written", async () => {
    const db = fakeSupabase();
    const res = await bookSalaryGroups(db.client, "acc", [
      { employee: { createName: "Abhishek", monthlyGross: 35000 }, period: "2026-06", lines: [line("a6", 70000)], incentive: 70000 },
    ]);
    expect(res[0].ok).toBe(false);
    expect(db.employees).toHaveLength(0);
    expect(db.paySalaryCalls).toHaveLength(0);
  });

  it("two lines of one month become one record, both reconciled to it", async () => {
    const db = fakeSupabase();
    const res = await bookSalaryGroups(db.client, "acc", [
      { employee: { createName: "Pawan", monthlyGross: 20000 }, period: "2026-04", lines: [line("a", 15000), line("b", 5000)] },
    ]);
    expect(res[0].ok).toBe(true);
    expect(db.salaries).toHaveLength(1);
    expect(db.salaries[0].net).toBe(20000);
    expect(db.reconciles.map((r) => r.salary)).toEqual([db.salaries[0].id, db.salaries[0].id]);
  });

  it("reconciles to an existing unpaid record instead of creating one", async () => {
    const db = fakeSupabase({ existing: [{ id: "old", employee_id: "e9", period: "2026-04", net: 21560, paid_amount: 0, paid_status: "unpaid" }] });
    const res = await bookSalaryGroups(db.client, "acc", [
      { employee: { id: "e9" }, period: "2026-04", lines: [line("t", 21560)] },
    ]);
    expect(res[0].ok).toBe(true);
    expect(db.salaries).toHaveLength(1);
    expect(db.reconciles).toEqual([{ txn: "t", salary: "old" }]);
  });

  it("refuses a month already paid, and touches nothing", async () => {
    const db = fakeSupabase({ existing: [{ id: "old", employee_id: "e9", period: "2026-04", net: 21560, paid_amount: 21560, paid_status: "paid" }] });
    const res = await bookSalaryGroups(db.client, "acc", [
      { employee: { id: "e9" }, period: "2026-04", lines: [line("t", 21560)] },
    ]);
    expect(res[0].ok).toBe(false);
    expect(res[0].message).toMatch(/already marked paid/);
    expect(db.reconciles).toHaveLength(0);
  });
});
