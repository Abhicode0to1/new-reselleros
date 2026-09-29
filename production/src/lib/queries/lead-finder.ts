/**
 * AI Lead Finder — profiles (owner-edited), candidates (server-written; approve / reject
 * here), runs. Approve creates the lead in the browser with the signed-in user's session,
 * the same way Add lead does, so RLS and the audit trail see a person, not the service role.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { requireTenantId } from "@/lib/queries/require-tenant";
import { toastError } from "@/lib/errors/toast-error";
import { leadNotes, type MxProvider } from "@/lib/leads/lead-finder";
import { readContact } from "@/lib/leads/lead-contacts";

export const FINDER_KEY = ["lead-finder"] as const;

export interface FinderProfileRow {
  id: string; name: string; cities: string; industries: string; company_size: string; products: string[];
  must_have: string; exclude: string; daily_limit: number; enabled: boolean; last_run_at: string | null;
}
export type FinderProfileInput = Omit<FinderProfileRow, "id" | "last_run_at"> & { id?: string };

export function useFinderProfiles() {
  return useQuery({
    queryKey: [...FINDER_KEY, "profiles"],
    queryFn: async (): Promise<FinderProfileRow[]> => {
      const { data, error } = await createClient().from("lead_finder_profiles").select("id, name, cities, industries, company_size, products, must_have, exclude, daily_limit, enabled, last_run_at").order("created_at");
      if (error) throw error;
      return (data ?? []) as FinderProfileRow[];
    },
  });
}

export function useSaveFinderProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: FinderProfileInput) => {
      const supabase = createClient();
      const tenantId = await requireTenantId(supabase);
      const { data: auth } = await supabase.auth.getUser();
      const row = { ...p, tenant_id: tenantId, updated_at: new Date().toISOString(), ...(p.id ? {} : { created_by: auth?.user?.id ?? null }) };
      const { error } = p.id
        ? await supabase.from("lead_finder_profiles").update(row).eq("id", p.id)
        : await supabase.from("lead_finder_profiles").insert(row);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: [...FINDER_KEY, "profiles"] }); toast.success("Profile saved"); },
    onError: (e) => toastError(e),
  });
}

export function useDeleteFinderProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => { const { error } = await createClient().from("lead_finder_profiles").delete().eq("id", id); if (error) throw error; },
    onSuccess: () => qc.invalidateQueries({ queryKey: [...FINDER_KEY, "profiles"] }),
    onError: (e) => toastError(e),
  });
}

export interface FinderCandidate {
  id: string; profile_id: string | null; company: string; domain: string; website: string | null; city: string | null; description: string | null;
  source_url: string | null; mx_provider: MxProvider | null; on_workspace: boolean | null; site_https: boolean | null; site_status: number | null;
  site_note: string | null; score: number | null; product: string | null; fit_reason: string | null; pitch: string | null;
  status: "new" | "approved" | "rejected" | "converted"; lead_id: string | null; created_at: string;
  /** holds signals.contact — email/phone read from the company's own site */
  signals: unknown;
}

export function useFinderCandidates() {
  return useQuery({
    queryKey: [...FINDER_KEY, "candidates"],
    queryFn: async (): Promise<FinderCandidate[]> => {
      const { data, error } = await createClient().from("lead_finder_candidates")
        .select("id, profile_id, company, domain, website, city, description, source_url, mx_provider, on_workspace, site_https, site_status, site_note, score, product, fit_reason, pitch, status, lead_id, created_at, signals")
        .order("score", { ascending: false, nullsFirst: false }).limit(1000);
      if (error) throw error;
      return (data ?? []) as FinderCandidate[];
    },
  });
}

export interface FinderRun { id: string; started_at: string; finished_at: string | null; trigger: string; discovered: number; skipped_dupe: number; saved: number; ok: boolean | null; error: string | null }
export function useFinderRuns() {
  return useQuery({
    queryKey: [...FINDER_KEY, "runs"],
    queryFn: async (): Promise<FinderRun[]> => {
      const { data, error } = await createClient().from("lead_finder_runs").select("*").order("started_at", { ascending: false }).limit(10);
      if (error) throw error;
      return (data ?? []) as FinderRun[];
    },
  });
}

export function useRunFinder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (profileId: string) => {
      const res = await fetch("/api/leads/finder/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profileId }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Run failed");
      return body as { discovered: number; skippedDupe: number; saved: number; noContact?: number; errors: string[] };
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: FINDER_KEY });
      const drop = r.noContact ? ` · ${r.noContact} ka contact nahi mila, Rejected mein` : "";
      if (r.saved === 0) toast.warning(`${r.discovered} mili, ${r.skippedDupe} pehle se thi — contact wali nayi koi nahi${drop}`);
      else toast.success(`${r.saved} nayi companies, sabka phone/email hai (${r.skippedDupe} pehle se thi${drop})`);
      if (r.errors?.length) toast.warning(r.errors[0]);
    },
    onError: (e) => { qc.invalidateQueries({ queryKey: FINDER_KEY }); toastError(e); },
  });
}

/** Read published email/phone from the candidates' own sites — ids, or the 25 best never checked. */
export function useFindContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { ids?: string[]; force?: boolean } = {}) => {
      const res = await fetch("/api/leads/finder/contacts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Contact check failed");
      return body as { checked: number; found: number; removed?: number };
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: FINDER_KEY }); qc.invalidateQueries({ queryKey: ["leads"] });
      if (r.checked === 0) toast.success("Sab companies ka contact pehle hi check ho chuka hai");
      else toast.success(`${r.checked} websites padhi — ${r.found} ka contact mila${r.removed ? `, ${r.removed} bina contact wali Rejected mein gayi` : ""}`);
    },
    onError: (e) => toastError(e),
  });
}

/** Approve → a lead in Sales & Pipeline (source ai-finder), candidate marked converted. */
export function useApproveCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (c: FinderCandidate) => {
      const supabase = createClient();
      const tenantId = await requireTenantId(supabase);
      const { data: auth } = await supabase.auth.getUser();
      const contact = readContact(c.signals);
      const leadId = "L-" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000).toString(36).toUpperCase();
      const { error } = await supabase.from("leads").insert({
        id: leadId, tenant_id: tenantId, company: c.company, domain: c.domain, stage: "new", source: "ai-finder",
        plan: c.product === "workspace" ? "Google Workspace" : null,
        contact_email: contact?.email ?? null, contact_phone: contact?.phone ?? null,
        notes: leadNotes(c), created_by: auth?.user?.id ?? null,
      });
      if (error) throw error;
      const { error: e2 } = await supabase.from("lead_finder_candidates").update({ status: "converted", lead_id: leadId, decided_by: auth?.user?.id ?? null, decided_at: new Date().toISOString() }).eq("id", c.id);
      if (e2) throw e2;
      return leadId;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: FINDER_KEY }); qc.invalidateQueries({ queryKey: ["leads"] }); toast.success("Lead ban gaya — Sales & Pipeline mein"); },
    onError: (e) => toastError(e),
  });
}

export function useRejectCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; undo?: boolean }) => {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      const { error } = await supabase.from("lead_finder_candidates").update(input.undo ? { status: "new", decided_by: null, decided_at: null } : { status: "rejected", decided_by: auth?.user?.id ?? null, decided_at: new Date().toISOString() }).eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [...FINDER_KEY, "candidates"] }),
    onError: (e) => toastError(e),
  });
}
