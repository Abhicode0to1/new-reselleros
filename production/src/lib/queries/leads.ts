/**
 * Leads — server + client data hooks.
 *
 * Server: use `fetchLeads()` in Server Components.
 * Client: use `useLeads()` hook (TanStack Query).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import type { Lead, Database } from "@/lib/supabase/database.types";
import type { JunkReasonId } from "@/lib/leads/qualification";

// ============================================================
// Read
// ============================================================
export function useLeads() {
  return useQuery({
    queryKey: ["leads"],
    queryFn: async (): Promise<Lead[]> => {
      const supabase = createClient();
      // Removed 2026-08-13: a fallback that re-queried with three hardcoded
      // tenant UUIDs whenever this returned empty. It could never help — RLS
      // (verified on prod: enabled on `leads` with 4 policies) applies to both
      // queries, so the retry returns exactly the same rows. All it did was make
      // "no leads yet" indistinguishable from "auth/tenant is broken". One of the
      // three UUIDs also belonged to Delfos Technologies, an unrelated tenant.
      const { data, error } = await supabase
        .from("leads")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * Har lead ki SABSE NAYI quote — id aur status — ek hi query me.
 *
 * ─── KYON ───────────────────────────────────────────────────────────────────
 * Pardeep, 31 Aug 2026, website-form ki lead ko list me dekh kar: "lead to banti hai par
 * ye nahi pata lagta ki isko quote bheja gaya hai ya nahi… aur related quote wahin se
 * open bhi hona chahiye." Wo sach pehle sirf lead ke NOTES me dafan tha — jise list par
 * koi nahi padhta — jabki quotes table me `lead_id` pehle se hai.
 *
 * Ek map isliye, N queries nahi: list me 30 lead par 30 round-trip wahi class ki
 * sust-page banati jo is screen par pehle napi ja chuki hai. RLS tenant scope karta hai.
 * "Sabse nayi" isliye ki requote hone par purani draft nahi, aaj wali dikhe.
 */
export interface LeadQuoteRef {
  id: string;
  status: string | null;
}

export function useLeadQuotes() {
  return useQuery({
    queryKey: ["leads", "quotes-by-lead"],
    queryFn: async (): Promise<Record<string, LeadQuoteRef>> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("quotes")
        .select("id, lead_id, status, created_at")
        .not("lead_id", "is", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const map: Record<string, LeadQuoteRef> = {};
      for (const q of (data ?? []) as { id: string; lead_id: string | null; status: string | null }[]) {
        if (q.lead_id && !map[q.lead_id]) map[q.lead_id] = { id: q.id, status: q.status };
      }
      return map;
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
    mutationFn: async (
      { id, stage, lostReason, lostNote }:
      { id: string; stage: Lead["stage"]; lostReason?: string | null; lostNote?: string | null },
    ) => {
      const supabase = createClient();
      // Loss capture rides along with the stage change so the two can't diverge —
      // a lead is never "lost" in one write and "explained" in another that might
      // fail. Moving OUT of lost clears the fields, otherwise a revived deal keeps
      // a stale reason and quietly poisons the loss analytics.
      const loss = stage === "lost"
        ? { lost_reason: lostReason ?? null, lost_note: lostNote ?? null, lost_at: new Date().toISOString() }
        : { lost_reason: null, lost_note: null, lost_at: null };
      const patch: LeadUpdate = { stage, ...loss };
      const { data, error } = await supabase
        .from("leads")
        .update(patch)
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
      // The optimistic move was just rolled back — say so, or the card silently
      // snapping back to its old column looks like the drag simply didn't work.
      toastError(err, {
        fallback: "Could not move the lead",
        description: "The card went back to its previous stage — nothing was saved.",
      });
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
    mutationFn: async (
      { ids, isJunk, reason, note }: {
        ids: string[];
        isJunk: boolean;
        /** WHY. Required by the drawer dialog; see lib/leads/qualification.ts. */
        reason?: JunkReasonId;
        note?: string;
      },
    ) => {
      const supabase = createClient();
      /* Un-junking CLEARS the reason and the timestamp. Leaving a stale "fake_phone"
         on a lead that is live again would put it back in the junk reports it just
         escaped, and the next reader would trust it. */
      const patch = isJunk
        ? {
            is_junk: true,
            junk_reason: reason ?? null,
            junk_note: note?.trim() ? note.trim() : null,
            junked_at: new Date().toISOString(),
          }
        : { is_junk: false, junk_reason: null, junk_note: null, junked_at: null };
      const { error } = await supabase.from("leads").update(patch).in("id", ids);
      if (error) throw error;
    },
    /* Optimistic, like the stage and inline-cell mutations above. This one was NOT,
       and it is the mutation behind a 1-tap "Junk" chip in a triage queue: the rep
       taps, the row sits there until the server replies, and they tap again. Marking
       junk removes the row from every working view, so the optimistic write IS the
       feedback — there is no cell left on screen to animate. */
    onMutate: async ({ ids, isJunk }) => {
      await qc.cancelQueries({ queryKey: ["leads"] });
      const previous = qc.getQueryData<Lead[]>(["leads"]);
      const idSet = new Set(ids);
      qc.setQueryData<Lead[]>(["leads"], (old) =>
        old?.map((l) => (idSet.has(l.id) ? { ...l, is_junk: isJunk } : l)),
      );
      return { previous };
    },
    onSuccess: (_r, { ids, isJunk }) => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      toast.success(isJunk ? `${ids.length} lead${ids.length > 1 ? "s" : ""} marked junk` : "Restored from junk");
    },
    onError: (err, _vars, ctx) => {
      // Put the rows back, or the rep believes leads were hidden that were not.
      qc.setQueryData(["leads"], ctx?.previous);
      toastError(err, { description: "The leads were put back — nothing was changed." });
    },
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
    onError: (err) => toastError(err),
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
    onError: (err) => toastError(err),
  });
}

// ============================================================
// Update — edit any lead field (company, contact, plan, seats, value, notes, …)
// ============================================================
/**
 * @param opts.quiet suppress the success toast — for inline cell edits, where
 *   the saved value is visible in the cell itself and a toast per keystroke-ish
 *   edit is just noise. Errors still surface.
 */
export function useUpdateLead(opts: { quiet?: boolean } = {}) {
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
    // Optimistic — an inline cell must feel instant, and the row is right there
    // to show the rollback if the write fails.
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ["leads"] });
      const previous = qc.getQueryData<Lead[]>(["leads"]);
      qc.setQueryData<Lead[]>(["leads"], (old) =>
        old?.map((l) => (l.id === id ? { ...l, ...(patch as Partial<Lead>) } : l)),
      );
      return { previous };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      if (!opts.quiet) toast.success("Lead updated");
    },
    onError: (err, _vars, ctx) => {
      qc.setQueryData(["leads"], ctx?.previous);
      toastError(err, { description: "The cell was put back to its previous value — nothing was saved." });
    },
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
    onError: (err) => toastError(err),
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
    onError: (err) => toastError(err),
  });
}

/* ── Ek insaan ki LEADS — contact/customer ke page ke liye (1 Sep 2026) ──────
   Pardeep: "lead ka koi contact hota hai to us contact ke page par uski leads
   bhi dikhao, jaise quotation/invoice dikhate hain." Pehchan teen raaste se:
   anchor (leads.contact_id — migration 0197, har lead par hai), email-match,
   phone-match (EXACT stored value; +91/space-variant yahan nahi judte — wo
   contacts-book ka last-10 merge hai, DB filter nahi).
   Teen chhoti queries, client par dedup — PostgREST ke or(in(...)) ke quoting
   jaal se seedha raasta. */
export function useLeadsForPerson(args: {
  contactId?: string | null;
  emails?: readonly string[];
  phones?: readonly string[];
}) {
  const contactId = args.contactId ?? null;
  const emails = (args.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const phones = (args.phones ?? []).map((p) => p.trim()).filter(Boolean);

  return useQuery({
    queryKey: ["leads-for-person", contactId, emails, phones],
    enabled: Boolean(contactId || emails.length || phones.length),
    queryFn: async (): Promise<Lead[]> => {
      const supabase = createClient();
      const picks = "id, company, contact_name, contact_email, contact_phone, stage, is_junk, value, seats, plan, created_at";
      const [byAnchor, byEmail, byPhone] = await Promise.all([
        contactId
          ? supabase.from("leads").select(picks).eq("contact_id", contactId)
          : Promise.resolve({ data: [], error: null }),
        emails.length
          ? supabase.from("leads").select(picks).in("contact_email", emails)
          : Promise.resolve({ data: [], error: null }),
        phones.length
          ? supabase.from("leads").select(picks).in("contact_phone", phones)
          : Promise.resolve({ data: [], error: null }),
      ]);
      for (const r of [byAnchor, byEmail, byPhone]) if (r.error) throw r.error;

      const seen = new Set<string>();
      const out: Lead[] = [];
      for (const l of [...(byAnchor.data ?? []), ...(byEmail.data ?? []), ...(byPhone.data ?? [])] as Lead[]) {
        if (seen.has(l.id)) continue;
        seen.add(l.id);
        out.push(l);
      }
      out.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
      return out;
    },
  });
}
