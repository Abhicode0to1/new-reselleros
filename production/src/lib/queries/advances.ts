/**
 * Employee Expense Advances & Petty Cash Management — TanStack Query hooks.
 *
 * Logically handles:
 * 1. Giving advance money to employees for official expenses (Assets / Petty cash in hand).
 * 2. Booking expenses against that advance (Hits P&L as Expense & reduces available advance balance).
 * 3. Settling / refunding remaining advance balance when project/travel completes.
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

      // Fetch advances & linked expenses
      const [{ data: advs, error: aErr }, { data: exps, error: eErr }] = await Promise.all([
        (supabase.from("employee_expense_advances" as any) as any).select("*").eq("tenant_id", tenant_id).order("disbursed_date", { ascending: false }),
        (supabase.from("expenses" as any) as any).select("*").eq("tenant_id", tenant_id).not("prepaid_advance_id", "is", null),
      ]);

      if (aErr) throw aErr;
      if (eErr) throw eErr;

      const expenseMap = new Map<string, Expense[]>();
      for (const e of (exps ?? []) as Expense[]) {
        if (e.prepaid_advance_id) {
          const list = expenseMap.get(e.prepaid_advance_id) ?? [];
          list.push(e);
          expenseMap.set(e.prepaid_advance_id, list);
        }
      }

      return (advs ?? []).map((a: any) => {
        const linked = expenseMap.get(a.id) ?? [];
        const total_spent = linked.reduce((sum, item) => sum + (item.amount || 0), 0);
        const remaining_balance = Math.max(0, (a.disbursed_amount || 0) - total_spent);
        return {
          ...a,
          disbursed_amount: Number(a.disbursed_amount),
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

      const { data, error } = await (supabase.from("employee_expense_advances" as any) as any)
        .insert({
          tenant_id,
          employee_id: input.employee_id || null,
          employee_name: input.employee_name,
          disbursed_amount: input.disbursed_amount,
          disbursed_date: input.disbursed_date,
          payment_method: input.payment_method,
          bank_account_id: input.bank_account_id || null,
          purpose: input.purpose || null,
          notes: input.notes || null,
          status: "active",
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employee_expense_advances"] });
      toast.success("Employee advance disbursed successfully");
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
      toast.success("Expense recorded and adjusted against advance!");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

export function useSettleAdvance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (advance_id: string) => {
      const supabase = createClient();
      const { error } = await (supabase.from("employee_expense_advances" as any) as any)
        .update({ status: "settled", updated_at: new Date().toISOString() })
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
