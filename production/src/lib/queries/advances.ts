/**
 * Employee Expense Advances & Petty Cash Management — TanStack Query hooks.
 *
 * Uses existing `expenses` table with category='Employee Advance Disbursal' and
 * `prepaid_advance_id` linking for 100% zero-migration compatibility across
 * local and production Supabase environments.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import type { Expense } from "@/lib/queries/expenses";

export type EmployeeAdvance = {
  id: string;
  tenant_id: string;
  employee_id: string | null;
  employee_name: string;
  disbursed_amount: number;
  disbursed_date: string;
  payment_method: string;
  bank_account_id: string | null;
  purpose: string | null;
  status: "active" | "settled" | "closed";
  notes: string | null;
  created_at: string;
  updated_at: string;
  // Computed fields
  total_spent: number;
  remaining_balance: number;
  linked_expenses: Expense[];
};

export const ADVANCE_PAYMENT_METHODS: Record<string, string> = {
  bank_transfer: "Bank Transfer (NEFT/RTGS/IMPS)",
  upi: "UPI (Google Pay / PhonePe / Paytm)",
  cash: "Petty Cash",
  cheque: "Cheque",
};

const ADVANCE_CATEGORY = "Employee Advance Disbursal";

async function getTenantId(): Promise<string> {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) throw new Error("Not authenticated");
  const { data: me, error } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", authData.user.id)
    .single();
  if (error || !me) throw new Error("User not linked to a tenant");
  return me.tenant_id;
}

export function useEmployeeAdvances() {
  return useQuery({
    queryKey: ["employee_expense_advances"],
    queryFn: async (): Promise<EmployeeAdvance[]> => {
      const supabase = createClient();
      const tenant_id = await getTenantId();

      // Fetch all advance disbursals + claimed expenses
      const [{ data: disbursals, error: dErr }, { data: claims, error: cErr }] = await Promise.all([
        (supabase.from("expenses" as any) as any)
          .select("*")
          .eq("tenant_id", tenant_id)
          .eq("category", ADVANCE_CATEGORY)
          .order("expense_date", { ascending: false }),
        (supabase.from("expenses" as any) as any)
          .select("*")
          .eq("tenant_id", tenant_id)
          .not("prepaid_advance_id", "is", null),
      ]);

      if (dErr) throw dErr;
      if (cErr) throw cErr;

      const claimMap = new Map<string, Expense[]>();
      for (const c of (claims ?? []) as Expense[]) {
        if (c.prepaid_advance_id) {
          const list = claimMap.get(c.prepaid_advance_id) ?? [];
          list.push(c);
          claimMap.set(c.prepaid_advance_id, list);
        }
      }

      return (disbursals ?? []).map((d: any) => {
        const linked = claimMap.get(d.id) ?? [];
        const total_spent = linked.reduce((sum, item) => sum + (item.amount || 0), 0);
        const disbursed_amount = Number(d.amount);
        const remaining_balance = Math.max(0, disbursed_amount - total_spent);

        // Parse employee name and purpose from vendor_name and description
        const empName = d.vendor_name || "Employee";
        const isSettled = d.notes?.includes("[SETTLED]") || (remaining_balance === 0 && linked.length > 0);

        return {
          id: d.id,
          tenant_id: d.tenant_id,
          employee_id: d.project_id || null,
          employee_name: empName,
          disbursed_amount,
          disbursed_date: d.expense_date,
          payment_method: d.payment_method || "bank_transfer",
          bank_account_id: d.bank_account_id || null,
          purpose: d.description || "Company Expenses Advance",
          status: isSettled ? "settled" : "active",
          notes: d.notes || null,
          created_at: d.created_at,
          updated_at: d.updated_at,
          total_spent,
          remaining_balance,
          linked_expenses: linked,
        };
      });
    },
  });
}

export function useDisburseAdvance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      employee_id?: string | null;
      employee_name: string;
      disbursed_amount: number;
      disbursed_date: string;
      payment_method: string;
      bank_account_id?: string | null;
      purpose?: string | null;
      notes?: string | null;
    }) => {
      const supabase = createClient();
      const tenant_id = await getTenantId();

      const { data, error } = await (supabase.from("expenses" as any) as any)
        .insert({
          tenant_id,
          category: ADVANCE_CATEGORY,
          amount: input.disbursed_amount,
          expense_date: input.disbursed_date,
          vendor_name: input.employee_name,
          description: input.purpose || "Employee Expense Advance",
          payment_method: input.payment_method,
          bank_account_id: input.bank_account_id || null,
          paid: true,
          paid_date: input.disbursed_date,
          notes: input.notes || null,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employee_expense_advances"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      toast.success("Employee advance disbursed successfully!");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

export function useRecordAdvanceExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      advance_id: string;
      category: string;
      amount: number;
      expense_date: string;
      vendor_name?: string | null;
      description?: string | null;
      attachment_url?: string | null;
    }) => {
      const supabase = createClient();
      const tenant_id = await getTenantId();

      const { data, error } = await (supabase.from("expenses" as any) as any)
        .insert({
          tenant_id,
          category: input.category,
          amount: input.amount,
          expense_date: input.expense_date,
          vendor_name: input.vendor_name || null,
          description: input.description || null,
          attachment_url: input.attachment_url || null,
          paid: true,
          paid_date: input.expense_date,
          prepaid_advance_id: input.advance_id,
          payment_method: "advance_deduction",
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employee_expense_advances"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      toast.success("Expense recorded & deducted from employee advance!");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

export function useSettleAdvance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (advance_id: string) => {
      const supabase = createClient();
      const { error } = await (supabase.from("expenses" as any) as any)
        .update({ notes: "[SETTLED] Employee advance closed", updated_at: new Date().toISOString() })
        .eq("id", advance_id);

      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employee_expense_advances"] });
      toast.success("Advance settled & closed successfully!");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}
