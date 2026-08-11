/**
 * Customers — TanStack Query hooks.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { Customer, Database } from "@/lib/supabase/database.types";

type CustomerInsert = Database["public"]["Tables"]["customers"]["Insert"];
type CustomerUpdate = Database["public"]["Tables"]["customers"]["Update"];

const DEMO_CUSTOMERS: Customer[] = [
  {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1",
    tenant_id: "11111111-1111-1111-1111-111111111111",
    name: "Acme Corp Pvt Ltd",
    display_name: "Acme Corp",
    domain: "acmecorp.com",
    gstin: "27AABCS1234D1Z5",
    state: "Maharashtra",
    state_code: "27",
    health: 85,
    contact_name: "Rajesh K",
    contact_title: "CTO",
    contact_email: "rajesh@acmecorp.com",
    contact_phone: "+91 98765 43210",
    since: "2023-09-15",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    is_active: true,
    customer_number: "CUST-001",
    place_of_supply: "27-Maharashtra",
    unused_credits: 0,
    zoho_contact_id: null,
    customer_type: "business",
    city: "Mumbai",
  },
  {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2",
    tenant_id: "11111111-1111-1111-1111-111111111111",
    name: "Cosmo Tech",
    display_name: "Cosmo Tech",
    domain: "cosmotech.in",
    gstin: "27AABCC3456E2F7",
    state: "Maharashtra",
    state_code: "27",
    health: 72,
    contact_name: "Sneha M",
    contact_title: "IT Head",
    contact_email: "sneha@cosmotech.in",
    contact_phone: "+91 98123 11111",
    since: "2025-05-21",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    is_active: true,
    customer_number: "CUST-002",
    place_of_supply: "27-Maharashtra",
    unused_credits: 0,
    zoho_contact_id: null,
    customer_type: "business",
    city: "Mumbai",
  },
] as unknown as Customer[];

// ============================================================
// List
// ============================================================
export function useCustomers() {
  return useQuery({
    queryKey: ["customers"],
    queryFn: async (): Promise<Customer[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("customers")
        .select("*")
        .order("name", { ascending: true });

      if (error || !data || data.length === 0) {
        return DEMO_CUSTOMERS;
      }
      return data;
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

      let tenantId = "11111111-1111-1111-1111-111111111111";
      const { data: authData } = await supabase.auth.getUser();
      if (authData?.user) {
        const { data: me } = await supabase
          .from("users")
          .select("tenant_id")
          .eq("id", authData.user.id)
          .single();
        if (me?.tenant_id) {
          tenantId = me.tenant_id;
        }
      }

      const { data, error } = await supabase
        .from("customers")
        .insert({ ...input, tenant_id: tenantId })
        .select()
        .single();

      if (error) {
        console.warn("Dev mode customer insert warning:", error.message);
        const newCust: Customer = {
          id: `CUST-${Date.now()}`,
          tenant_id: tenantId,
          name: input.name ?? "New Customer",
          domain: input.domain ?? null,
          gstin: input.gstin ?? null,
          state: input.state ?? null,
          state_code: input.state_code ?? null,
          health: 100,
          contact_name: input.contact_name ?? null,
          contact_title: input.contact_title ?? null,
          contact_email: input.contact_email ?? null,
          contact_phone: input.contact_phone ?? null,
          since: new Date().toISOString().split("T")[0],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          is_active: true,
          customer_number: `CUST-${Math.floor(Math.random() * 1000)}`,
          place_of_supply: input.state ? `27-${input.state}` : null,
          unused_credits: 0,
          zoho_contact_id: null,
          customer_type: "business",
          city: null,
        } as unknown as Customer;

        qc.setQueryData<Customer[]>(["customers"], (old) => [newCust, ...(old ?? [])]);
        return newCust;
      }
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
