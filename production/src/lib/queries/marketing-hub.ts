/**
 * Marketing Hub queries — tool state, tracking links, email opt-outs.
 * Tables from migration 20260926190000_marketing_hub.sql; the tool catalogue and the link
 * builder are pure (lib/marketing/tool-catalog.ts, tracking-link.ts).
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { requireTenantId } from "@/lib/queries/require-tenant";
import { isMarketingCategory } from "@/lib/marketing/ad-channels";
import type { ToolState, ToolStatus } from "@/lib/marketing/tool-catalog";

/* These tables are newer than the generated types (database.types.ts is shared and kept
   minimal), so they are read through an untyped handle with the row shape stated here. */
type Untyped = { from: (t: string) => any };  // eslint-disable-line @typescript-eslint/no-explicit-any
const db = () => createClient() as unknown as Untyped & ReturnType<typeof createClient>;

const TOOLS_KEY = ["marketing-tools"] as const;
const LINKS_KEY = ["tracking-links"] as const;
const SUPPRESS_KEY = ["email-suppressions"] as const;

// ── Tools ────────────────────────────────────────────────────────────────────

export function useMarketingTools() {
  return useQuery({
    queryKey: TOOLS_KEY,
    queryFn: async (): Promise<ToolState[]> => {
      const { data, error } = await db().from("marketing_tools")
        .select("tool_key, status, account_url, owner_name, monthly_budget, notes");
      if (error) throw error;
      return (data ?? []) as ToolState[];
    },
  });
}

export function useSaveMarketingTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      tool_key: string; name: string; status: ToolStatus;
      account_url: string | null; owner_name: string | null; monthly_budget: number; notes: string | null;
    }) => {
      const supabase = createClient();
      const tenantId = await requireTenantId(supabase);
      const { error } = await db().from("marketing_tools").upsert(
        { ...input, tenant_id: tenantId, monthly_budget: Math.max(0, Math.round(input.monthly_budget || 0)), updated_at: new Date().toISOString() },
        { onConflict: "tenant_id,tool_key" },
      );
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: TOOLS_KEY }); toast.success("Saved"); },
    onError: (err) => toast.error((err as Error).message),
  });
}

/** This calendar month's recorded marketing spend per channel (expenses.channel). */
export function useSpendThisMonth() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  return useQuery({
    queryKey: ["expenses", "spend-by-channel-month", iso(start)],
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await createClient()
        .from("expenses")
        .select("channel, amount, category")
        .not("channel", "is", null)
        .gte("expense_date", iso(start))
        .lt("expense_date", iso(end));
      if (error) throw error;
      const out: Record<string, number> = {};
      for (const r of (data ?? []) as { channel: string | null; amount: number | null; category: string | null }[]) {
        if (!r.channel || !isMarketingCategory(r.category)) continue;
        out[r.channel] = (out[r.channel] ?? 0) + (r.amount ?? 0);
      }
      return out;
    },
  });
}

// ── Tracking links ───────────────────────────────────────────────────────────

export interface TrackingLink {
  id: string; label: string; channel: string; utm_medium: string; utm_campaign: string;
  utm_content: string | null; destination_path: string; full_url: string; created_at: string;
  /** Leads that arrived with this link's source + campaign. */
  leads: number;
  won: number;
}

export function useTrackingLinks() {
  return useQuery({
    queryKey: LINKS_KEY,
    queryFn: async (): Promise<TrackingLink[]> => {
      const { data, error } = await db().from("tracking_links")
        .select("id, label, channel, utm_medium, utm_campaign, utm_content, destination_path, full_url, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      const links = (data ?? []) as Omit<TrackingLink, "leads" | "won">[];
      if (links.length === 0) return [];

      /* Count leads per (source, campaign). One query over the campaigns in use, not one
         per link. */
      const { data: leads, error: lErr } = await createClient()
        .from("leads")
        .select("utm_source, utm_campaign, stage")
        .in("utm_campaign", [...new Set(links.map((l) => l.utm_campaign))]);
      if (lErr) throw lErr;
      const count = new Map<string, { leads: number; won: number }>();
      for (const l of (leads ?? []) as { utm_source: string | null; utm_campaign: string | null; stage: string | null }[]) {
        const k = `${(l.utm_source ?? "").toLowerCase()}|${l.utm_campaign ?? ""}`;
        const c = count.get(k) ?? { leads: 0, won: 0 };
        c.leads++; if (l.stage === "won") c.won++;
        count.set(k, c);
      }
      return links.map((l) => ({ ...l, ...(count.get(`${l.channel}|${l.utm_campaign}`) ?? { leads: 0, won: 0 }) }));
    },
  });
}

export function useCreateTrackingLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<TrackingLink, "id" | "created_at" | "leads" | "won">) => {
      const supabase = createClient();
      const tenantId = await requireTenantId(supabase);
      const { data: auth } = await supabase.auth.getUser();
      const { error } = await db().from("tracking_links").insert({ ...input, tenant_id: tenantId, created_by: auth?.user?.id ?? null });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: LINKS_KEY }); toast.success("Link saved"); },
    onError: (err) => toast.error((err as Error).message),
  });
}

export function useDeleteTrackingLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db().from("tracking_links").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: LINKS_KEY }); toast.success("Link removed — leads already captured keep their source"); },
    onError: (err) => toast.error((err as Error).message),
  });
}

// ── Email opt-outs ───────────────────────────────────────────────────────────

export interface Suppression { email: string; reason: string; campaign_id: string | null; created_at: string }

export function useEmailSuppressions() {
  return useQuery({
    queryKey: SUPPRESS_KEY,
    queryFn: async (): Promise<Suppression[]> => {
      const { data, error } = await db().from("email_suppressions")
        .select("email, reason, campaign_id, created_at").order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Suppression[];
    },
  });
}

/** Put an address back on the list — only when the person asked for it. */
export function useRemoveSuppression() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (email: string) => {
      const { error } = await db().from("email_suppressions").delete().eq("email", email);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: SUPPRESS_KEY }); toast.success("Removed from opt-out list"); },
    onError: (err) => toast.error((err as Error).message),
  });
}
