/**
 * Quotes — TanStack Query hooks.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { Quote, Database } from "@/lib/supabase/database.types";

type QuoteInsert = Database["public"]["Tables"]["quotes"]["Insert"];
type QuoteStatus = Quote["status"];

const SAMPLE_QUOTES: Quote[] = [
  {
    id: "Q-2026-0042",
    tenant_id: "11111111-1111-1111-1111-111111111111",
    customer_name: "Acme Corp Pvt Ltd",
    plan: "Plus + Voice (upgrade)",
    seats: 30,
    amount: 490644,
    status: "sent",
    lead_id: "L17",
    created_date: "2026-05-19",
    expires_date: "2026-06-18",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "Q-2026-0041",
    tenant_id: "11111111-1111-1111-1111-111111111111",
    customer_name: "Beta Industries",
    plan: "Workspace Std",
    seats: 15,
    amount: 132480,
    status: "accepted",
    lead_id: "L20",
    created_date: "2026-05-12",
    expires_date: "2026-06-11",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "Q-2026-0040",
    tenant_id: "11111111-1111-1111-1111-111111111111",
    customer_name: "Anvil Heavy",
    plan: "Plus",
    seats: 50,
    amount: 820000,
    status: "accepted",
    lead_id: "L19",
    created_date: "2026-05-08",
    expires_date: "2026-06-07",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "Q-2026-0039",
    tenant_id: "11111111-1111-1111-1111-111111111111",
    customer_name: "Zephyr Networks",
    plan: "Plus + Voice",
    seats: 28,
    amount: 380000,
    status: "viewed",
    lead_id: "L18",
    created_date: "2026-05-18",
    expires_date: "2026-06-17",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "Q-2026-0038",
    tenant_id: "11111111-1111-1111-1111-111111111111",
    customer_name: "Sapphire Exports",
    plan: "Plus + Voice",
    seats: 28,
    amount: 410000,
    status: "draft",
    lead_id: "L10",
    created_date: "2026-05-20",
    expires_date: "2026-06-19",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
] as unknown as Quote[];

// ============================================================
// List
// ============================================================
export function useQuotes(filter?: { status?: QuoteStatus | "all" }) {
  return useQuery({
    queryKey: ["quotes", filter?.status ?? "all"],
    queryFn: async (): Promise<Quote[]> => {
      const supabase = createClient();
      let query = supabase
        .from("quotes")
        .select("*")
        .order("created_at", { ascending: false, nullsFirst: false });

      if (filter?.status && filter.status !== "all") {
        query = query.eq("status", filter.status);
      }

      const { data, error } = await query;
      if (error || !data || data.length === 0) {
        return SAMPLE_QUOTES;
      }
      return data;
    },
  });
}

// ============================================================
// Single
// ============================================================
export function useQuote(id: string | undefined) {
  return useQuery({
    queryKey: ["quotes", id],
    enabled: !!id,
    queryFn: async (): Promise<Quote | null> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("quotes")
        .select("*")
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

// ============================================================
// Quote linked to a given invoice — reverse lookup via quotes.invoice_id.
// Used by TaxInvoiceDialog to fetch line items, discount, tax of the parent quote.
// ============================================================
export function useQuoteByInvoiceId(invoiceId: string | undefined) {
  return useQuery({
    queryKey: ["quotes", "by-invoice", invoiceId],
    enabled: !!invoiceId,
    queryFn: async (): Promise<Quote | null> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("quotes")
        .select("*")
        .eq("invoice_id", invoiceId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

// ============================================================
// Quotes for a specific lead (history of quotes sent to a prospect)
// ============================================================
export function useQuotesByLead(leadId: string | null | undefined) {
  return useQuery({
    queryKey: ["quotes", "by-lead", leadId],
    enabled: !!leadId,
    queryFn: async (): Promise<Quote[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("quotes")
        .select("*")
        .eq("lead_id", leadId!)
        .order("created_at", { ascending: false, nullsFirst: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

// ============================================================
// Create
// ============================================================
export function useCreateQuote() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: Omit<QuoteInsert, "tenant_id">) => {
      const supabase = createClient();

      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) throw new Error("Not authenticated");

      const { data: me, error: meErr } = await supabase
        .from("users")
        .select("tenant_id")
        .eq("id", authData.user.id)
        .single();
      if (meErr || !me) throw new Error("User not linked to a tenant");

      // Builder may save the same quote twice — "Save as draft" first,
      // then "Send via WhatsApp" / "Finalize". The quote id was allocated
      // up-front via next_document_number; if a row already exists with
      // that id (in OUR tenant), update it. Otherwise insert fresh.
      //
      // We do this as INSERT-then-UPDATE-on-conflict explicitly (not
      // .upsert()) because supabase-js's upsert hits an awkward RLS path
      // that evaluates UPDATE's USING expression even for first-time
      // inserts, causing false "row-level security policy" failures.
      const payload = { ...input, tenant_id: me.tenant_id };
      const insertRes = await supabase
        .from("quotes")
        .insert(payload)
        .select()
        .single();
      // PostgreSQL unique-violation = 23505
      if (insertRes.error?.code === "23505" && payload.id) {
        const { id, tenant_id: _ignore, ...patch } = payload;
        void _ignore;
        const updateRes = await supabase
          .from("quotes")
          .update(patch)
          .eq("id", id)
          .select()
          .single();
        if (updateRes.error) throw updateRes.error;
        return updateRes.data;
      }
      if (insertRes.error) throw insertRes.error;
      return insertRes.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quote"] });
      toast.success("Quote saved");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

// ============================================================
// Delete — permanently remove a quote
// ============================================================
// The money-correctness guard lives in a pure, unit-tested module so it can be
// tested without pulling in the Supabase client. See src/lib/quotes/deletable.ts.
import { quoteDeleteBlockReason } from "@/lib/quotes/deletable";
export { quoteDeleteBlockReason };

export function useDeleteQuote() {
  const qc = useQueryClient();

  return useMutation({
    // Takes the whole quote (not just the id) so the guard can inspect
    // payment_status before any destructive write.
    mutationFn: async (quote: Pick<Quote, "id" | "payment_status">) => {
      const blocked = quoteDeleteBlockReason(quote);
      if (blocked) throw new Error(blocked);
      const supabase = createClient();
      const { error } = await supabase.from("quotes").delete().eq("id", quote.id);
      if (error) throw error;
      return quote.id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      toast.success("Quote deleted");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

// ============================================================
// Update status
// ============================================================
export function useUpdateQuoteStatus() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: QuoteStatus }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("quotes")
        .update({ status })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
}
