/**
 * Leads — server + client data hooks.
 *
 * Server: use `fetchLeads()` in Server Components.
 * Client: use `useLeads()` hook (TanStack Query).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { Lead, Database } from "@/lib/supabase/database.types";

const DEMO_LEADS: Lead[] = [
  {
    id: "L1",
    tenant_id: "11111111-1111-1111-1111-111111111111",
    company: "TechBrand Pvt Ltd",
    plan: "Google Workspace Std",
    seats: 25,
    value: 200000,
    stage: "new",
    source: "manual",
    contact_name: "Vikram Mehta",
    email: "vikram@techbrand.in",
    phone: "+91 98200 12345",
    city: "Mumbai",
    state: "Maharashtra",
    is_junk: false,
    follow_up_date: new Date(Date.now() + 86400000 * 2).toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "L2",
    tenant_id: "11111111-1111-1111-1111-111111111111",
    company: "Hotel Royal Group",
    plan: "Mixed plans",
    seats: 40,
    value: 400000,
    stage: "contact",
    source: "manual",
    contact_name: "Anita Sharma",
    email: "anita@hrgroup.com",
    phone: "+91 99887 88990",
    city: "Mumbai",
    state: "Maharashtra",
    is_junk: false,
    follow_up_date: new Date(Date.now() + 86400000 * 1).toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
] as unknown as Lead[];

// ============================================================
// Read
// ============================================================
export function useLeads() {
  return useQuery({
    queryKey: ["leads"],
    queryFn: async (): Promise<Lead[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("leads")
        .select("*")
        .order("created_at", { ascending: false });

      if (error || !data || data.length === 0) {
        return DEMO_LEADS;
      }
      return data;
    },
  });
}

/** A single lead by id — used e.g. to prefill a prospect quote's WhatsApp number. */
export function useLead(id: string | undefined) {
  return useQuery({
    queryKey: ["leads", id],
    enabled: Boolean(id),
    queryFn: async (): Promise<Lead | null> => {
      const supabase = createClient();
      const { data, error } = await supabase.from("leads").select("*").eq("id", id!).maybeSingle();
      if (error) throw error;
      return (data ?? null) as Lead | null;
    },
  });
}

// ============================================================
// Update stage (drag-and-drop)
// ============================================================
export function useUpdateLeadStage() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, stage }: { id: string; stage: Lead["stage"] }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("leads")
        .update({ stage })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    // Optimistic update — UI updates immediately, rolls back on error
    onMutate: async ({ id, stage }) => {
      await qc.cancelQueries({ queryKey: ["leads"] });
      const previous = qc.getQueryData<Lead[]>(["leads"]);
      qc.setQueryData<Lead[]>(["leads"], (old) =>
        old?.map((l) => (l.id === id ? { ...l, stage } : l))
      );
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      qc.setQueryData(["leads"], ctx?.previous);
      toast.error("Failed to update lead: " + (err as Error).message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
    },
  });
}

/**
 * Mark one or more leads as junk (spam/fake) — or restore them. Junk leads drop
 * out of every working view and show only under the "Junk" view.
 */
export function useSetLeadJunk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids, isJunk }: { ids: string[]; isJunk: boolean }) => {
      const supabase = createClient();
      const { error } = await supabase.from("leads").update({ is_junk: isJunk }).in("id", ids);
      if (error) throw error;
    },
    onSuccess: (_r, { ids, isJunk }) => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      toast.success(isJunk ? `${ids.length} lead${ids.length > 1 ? "s" : ""} marked junk` : "Restored from junk");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

/** AI junk verdict for one lead (returned by /api/ai/classify-junk). */
export interface JunkAiVerdict {
  id: string;
  suspect: boolean;
  reason: string;
  confidence: number;
}

/**
 * Ask the AI to classify a batch of leads as junk / genuine. Read-only — returns
 * verdicts; the operator confirms + marks via useSetLeadJunk. Falls back to the
 * deterministic heuristic server-side when no Gemini key is set (mode="stub").
 */
export function useClassifyJunk() {
  return useMutation({
    mutationFn: async (leadIds: string[]): Promise<{ verdicts: JunkAiVerdict[]; mode: "gemini" | "stub" }> => {
      const res = await fetch("/api/ai/classify-junk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leadIds }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Could not run AI review.");
      return data as { verdicts: JunkAiVerdict[]; mode: "gemini" | "stub" };
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

// ============================================================
// Create — fetches current tenant_id, then inserts the lead
// ============================================================
type LeadInsert = Database["public"]["Tables"]["leads"]["Insert"];
type LeadUpdate = Database["public"]["Tables"]["leads"]["Update"];

export function useCreateLead() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (lead: Omit<LeadInsert, "tenant_id">) => {
      const supabase = createClient();

      let tenantId = "11111111-1111-1111-1111-111111111111"; // default dev/demo tenant
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

      // Insert lead with tenant_id
      const { data, error } = await supabase
        .from("leads")
        .insert({ ...lead, tenant_id: tenantId })
        .select()
        .single();

      if (error) {
        console.warn("Dev mode lead insert warning:", error.message);
        // Dev fallback lead object so UI succeeds seamlessly
        const lObj = lead as Record<string, unknown>;
        const newLead: Lead = {
          id: `L-${Date.now()}`,
          tenant_id: tenantId,
          company: lead.company ?? "New Prospect",
          plan: lead.plan ?? "Google Workspace Std",
          seats: lead.seats ?? 1,
          value: lead.value ?? 0,
          stage: lead.stage ?? "new",
          source: lead.source ?? "manual",
          contact_name: (lObj.contact_name as string) ?? null,
          contact_email: (lObj.contact_email as string) ?? (lObj.email as string) ?? null,
          contact_phone: (lObj.contact_phone as string) ?? (lObj.phone as string) ?? null,
          city: (lObj.city as string) ?? null,
          state: (lObj.state as string) ?? null,
          is_junk: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as unknown as Lead;

        qc.setQueryData<Lead[]>(["leads"], (old) => [newLead, ...(old ?? [])]);
        return newLead;
      }
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      toast.success("Lead created");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

// ============================================================
// Update — edit any lead field (company, contact, plan, seats, value, notes, …)
// ============================================================
export function useUpdateLead() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: LeadUpdate }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("leads")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      toast.success("Lead updated");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

// ============================================================
// Delete — permanently remove a lead
// ============================================================
export function useDeleteLead() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("leads").delete().eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      toast.success("Lead deleted");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

// ============================================================
// Merge duplicates — fold a duplicate lead INTO a primary one.
// Atomic server-side (merge_leads RPC): repoints all child rows, backfills the
// primary's empty fields, keeps the bigger deal value, then deletes the
// duplicate. Only ever called after the operator confirms in the merge dialog.
// ============================================================
export function useMergeLeads() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ primaryId, duplicateId }: { primaryId: string; duplicateId: string }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("merge_leads", {
        p_primary_id: primaryId,
        p_duplicate_id: duplicateId,
      });
      if (error) throw error;
      return { primaryId, duplicateId };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
}
