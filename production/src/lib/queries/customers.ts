/**
 * Customers — TanStack Query hooks.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { resolveTenantId } from "./tenant-id";
import type { Customer, Database } from "@/lib/supabase/database.types";

type CustomerInsert = Database["public"]["Tables"]["customers"]["Insert"];
type CustomerUpdate = Database["public"]["Tables"]["customers"]["Update"];

// ============================================================
// List
// ============================================================
export function useCustomers() {
  return useQuery({
    queryKey: ["customers"],
    queryFn: async (): Promise<Customer[]> => {
      const supabase = createClient();
      // Removed 2026-08-13 — same dead hardcoded-tenant fallback as leads.ts.
      // RLS (verified on prod: enabled on `customers`, 5 policies) filters the
      // retry identically, so it could never return a row the first query didn't.
      const { data, error } = await supabase
        .from("customers")
        .select("*")
        .order("name", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}

// ============================================================
// Single
// ============================================================
export function useCustomer(id: string | undefined) {
  return useQuery({
    queryKey: ["customers", id],
    enabled: !!id,
    queryFn: async (): Promise<Customer | null> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("customers")
        .select("*")
        .eq("id", id!)
        .maybeSingle();
      if (error) {
        console.warn("Supabase customer query warning:", error.message);
        return null;
      }
      return data;
    },
  });
}

// ============================================================
// Create — fetches current tenant_id automatically
// ============================================================
export function useCreateCustomer() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: Omit<CustomerInsert, "tenant_id">) => {
      const supabase = createClient();

      /* ─── THE TENANT IS RESOLVED, NOT GUESSED ───────────────────────
         Was `let tenantId = "11111111-…"` with the real lookup only overwriting
         it on success — so an expired session inserted this row into a hardcoded
         workspace instead of refusing. `resolveTenantId` throws, and the throw is
         the correct outcome: no row beats a row in somebody else's tenant.
         It is also the shared query, so this no longer costs two round-trips of
         its own (see queries/tenant-id.ts). */
      const tenantId = await resolveTenantId(supabase as never);

      const { data, error } = await supabase
        .from("customers")
        .insert({ ...input, tenant_id: tenantId })
        .select()
        .single();

      /* ─── A FAILED INSERT IS A FAILURE ─────────────────────────────
         This used to catch the error, build a fake row with a `CUST-${Date.now()}`
         id, push it into the React Query cache and return it — which let
         `onSuccess` fire and tell the operator "Customer added". Nothing had been
         saved, and the row disappeared on the next reload. Reporting a write
         that did not happen as a success is exactly what CLAUDE.md §0.4 forbids;
         the error now reaches onError, which shows it. */
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      toast.success("Customer added");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

// ============================================================
// Update
// ============================================================
export function useUpdateCustomer() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: CustomerUpdate }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("customers")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customers", data.id] });
      toast.success("Customer updated");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

// ============================================================
// Delete — guarded via the delete_customer RPC. The RPC refuses to delete a
// customer that still has subscriptions / payments / invoices (money history);
// only "empty" customers can be removed. See src/lib/customers/deletable.ts
// for the client-side twin used to disable the delete control.
// ============================================================
export { customerDeleteBlockReason } from "@/lib/customers/deletable";

export function useDeleteCustomer() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("delete_customer", { p_customer_id: id });
      if (error) throw error;
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      toast.success("Customer deleted");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

/** Archive / reactivate a customer (Zoho-style "Mark as Inactive"). Flips the
 *  is_active flag only — never touches invoices/payments/GST records. Reversible.
 *  This is the right action for a customer that can't be deleted (has money
 *  history) but is no longer doing business with us. */
export function useSetCustomerActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const supabase = createClient();
      const { error } = await supabase.from("customers").update({ is_active: isActive }).eq("id", id);
      if (error) throw error;
      return { id, isActive };
    },
    onSuccess: ({ id, isActive }) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customers", id] });
      toast.success(isActive ? "Customer reactivated" : "Customer archived — hidden from the active list");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

/** Total OPEN advance credit (₹) this customer holds — from earlier overpayments.
 *  Adjust it against their next bill in the record-payment sheet. */
export function useCustomerOpenCredit(customerId: string | null | undefined) {
  return useQuery({
    queryKey: ["customer_credits", "open-total", customerId ?? "none"],
    enabled: Boolean(customerId),
    queryFn: async (): Promise<number> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("customer_credits").select("amount").eq("customer_id", customerId!).eq("status", "open");
      if (error) throw error;
      return (data ?? []).reduce((s, r) => s + (r.amount ?? 0), 0);
    },
    staleTime: 30_000,
  });
}

/** Total OPEN advance credit (₹) per customer, across the whole tenant — for the
 *  customers list "Unused credits" column. RLS scopes the read to this tenant. */
export function useOpenCreditsByCustomer() {
  return useQuery({
    queryKey: ["customer_credits", "open-by-customer"],
    queryFn: async (): Promise<Record<string, number>> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("customer_credits").select("customer_id, amount").eq("status", "open");
      if (error) throw error;
      const map: Record<string, number> = {};
      for (const r of data ?? []) {
        if (!r.customer_id) continue;
        map[r.customer_id] = (map[r.customer_id] ?? 0) + (r.amount ?? 0);
      }
      return map;
    },
    staleTime: 30_000,
  });
}
