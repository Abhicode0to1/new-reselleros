/**
 * Contacts — aggregated view of every person known to the tenant (leads + customers).
 * Pure derivation from existing tables; no new DB schema yet.
 *
 * Down the line we can promote this to a real `contacts` table when we need
 * standalone contacts (newsletter subscribers, networking, etc.) or richer
 * features like tags, opt-out, lifecycle stage.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { ContactRow, ContactChannel } from "@/lib/supabase/database.types";

export type Contact = ContactRow;
export type { ContactChannel } from "@/lib/supabase/database.types";

export type ContactSource = "lead" | "customer" | "imported";

export interface UnifiedContact {
  id:        string;            // "lead:<id>" / "customer:<id>" / "imported:<id>"
  source:    ContactSource;
  refId:     string;            // original lead.id / customer.id / contacts.id
  name:      string | null;
  email:     string | null;
  phone:     string | null;
  company:   string;
  title:     string | null;
  /** For leads: stage. For customers: health (0-100). For imported: pending/engaged/promoted/archived. */
  status:    string | null;
  /** Sub-source for imported contacts: 'google_csv' | 'manual' | etc. */
  importedFrom?: string;
  createdAt: string;
}

export function useAllContacts() {
  return useQuery({
    queryKey: ["contacts", "all"],
    queryFn: async (): Promise<UnifiedContact[]> => {
      const supabase = createClient();

      const [leadsRes, customersRes, importedRes] = await Promise.all([
        supabase
          .from("leads")
          .select("id, company, contact_name, contact_email, contact_phone, stage, created_at"),
        supabase
          .from("customers")
          .select("id, name, contact_name, contact_title, contact_email, contact_phone, health, created_at"),
        supabase
          .from("contacts")
          .select("id, full_name, email, phone, company, title, source, status, created_at")
          // Hide promoted contacts here — they show up via the leads row already
          .neq("status", "promoted"),
      ]);

      if (leadsRes.error)     throw leadsRes.error;
      if (customersRes.error) throw customersRes.error;
      if (importedRes.error)  throw importedRes.error;

      const fromLeads: UnifiedContact[] = (leadsRes.data ?? [])
        .filter((l) => l.contact_name || l.contact_email || l.contact_phone)
        .map((l) => ({
          id:        `lead:${l.id}`,
          source:    "lead" as const,
          refId:     l.id,
          name:      l.contact_name,
          email:     l.contact_email,
          phone:     l.contact_phone,
          company:   l.company,
          title:     null,
          status:    l.stage,
          createdAt: l.created_at,
        }));

      const fromCustomers: UnifiedContact[] = (customersRes.data ?? [])
        .filter((c) => c.contact_name || c.contact_email || c.contact_phone)
        .map((c) => ({
          id:        `customer:${c.id}`,
          source:    "customer" as const,
          refId:     c.id,
          name:      c.contact_name,
          email:     c.contact_email,
          phone:     c.contact_phone,
          company:   c.name,
          title:     c.contact_title,
          status:    c.health != null ? String(c.health) : null,
          createdAt: c.created_at,
        }));

      const fromImported: UnifiedContact[] = (importedRes.data ?? []).map((c) => ({
        id:           `imported:${c.id}`,
        source:       "imported" as const,
        refId:        c.id,
        name:         c.full_name,
        email:        c.email,
        phone:        c.phone,
        company:      c.company ?? "—",
        title:        c.title,
        status:       c.status,
        importedFrom: c.source,
        createdAt:    c.created_at,
      }));

      // Combine + dedupe by email (a customer + lead with same email = 1 contact, prefer customer)
      const seenEmails = new Set<string>();
      const combined: UnifiedContact[] = [];

      for (const c of fromCustomers) {
        const key = c.email?.toLowerCase().trim();
        if (key) seenEmails.add(key);
        combined.push(c);
      }
      for (const l of fromLeads) {
        const key = l.email?.toLowerCase().trim();
        if (key && seenEmails.has(key)) continue;
        if (key) seenEmails.add(key);
        combined.push(l);
      }
      for (const i of fromImported) {
        const key = i.email?.toLowerCase().trim();
        if (key && seenEmails.has(key)) continue;
        if (key) seenEmails.add(key);
        combined.push(i);
      }

      // Sort by created date desc
      combined.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return combined;
    },
  });
}

// ============================================================
// Standalone contacts (the real `contacts` table) — full CRUD.
// These are the owner's own people: networking / marketing / personal
// outreach contacts with rich profile detail (social + address).
// ============================================================

/** One contact by id (contacts-table record). */
export function useContact(id: string | undefined) {
  return useQuery({
    queryKey: ["contact", id],
    enabled: Boolean(id),
    queryFn: async (): Promise<Contact | null> => {
      const supabase = createClient();
      const { data, error } = await supabase.from("contacts").select("*").eq("id", id!).maybeSingle();
      if (error) throw error;
      return (data ?? null) as Contact | null;
    },
  });
}

/** Fields the owner edits on a contact — everything except system columns. */
export type ContactFormValues = {
  full_name: string;
  company?:  string | null;
  /** Optional link to a customer company — surfaces that company's records on
   *  the contact detail page. null = free-text `company` only. */
  customer_id?: string | null;
  title?:    string | null;
  /** All emails/phones (each labelled). The mutations mirror index 0 into the
   *  legacy `email`/`phone` primary columns so existing consumers keep working. */
  emails?:   ContactChannel[];
  phones?:   ContactChannel[];
  email?:    string | null;
  phone?:    string | null;
  whatsapp?: string | null;
  linkedin?: string | null;
  instagram?:string | null;
  facebook?: string | null;
  twitter?:  string | null;
  website?:  string | null;
  address?:  string | null;
  city?:     string | null;
  tags?:     string[];
  notes?:    string | null;
};

function newContactId(): string {
  return "C-" + Date.now().toString(36).toUpperCase() + "-" + Math.floor(Math.random() * 1000).toString(36).toUpperCase();
}

/**
 * Normalize form values before write: clean the email/phone arrays (drop blanks,
 * default labels) and mirror the PRIMARY (index 0) into the legacy email/phone
 * columns so the list, reach buttons, dedupe, campaigns and AI all keep working.
 */
function normalizeChannels(values: ContactFormValues): ContactFormValues {
  const out = { ...values };
  if (values.emails) {
    const cleaned = values.emails
      .map((e) => ({ value: (e.value ?? "").trim(), label: e.label || "other" }))
      .filter((e) => e.value !== "");
    out.emails = cleaned;
    out.email = cleaned[0]?.value ?? null;
  }
  if (values.phones) {
    const cleaned = values.phones
      .map((p) => ({ value: (p.value ?? "").trim(), label: p.label || "mobile" }))
      .filter((p) => p.value !== "");
    out.phones = cleaned;
    out.phone = cleaned[0]?.value ?? null;
  }
  return out;
}

/** Create a standalone contact (source='manual'). Resolves tenant_id from auth. */
export function useCreateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: ContactFormValues): Promise<string> => {
      const supabase = createClient();
      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) throw new Error("Not signed in");
      const { data: me, error: meErr } = await supabase
        .from("users").select("tenant_id").eq("id", authData.user.id).single();
      if (meErr) throw meErr;

      const id = newContactId();
      const { error } = await supabase.from("contacts").insert({
        id,
        tenant_id: me!.tenant_id,
        source:    "manual",
        status:    "engaged",
        ...normalizeChannels(values),
      });
      if (error) throw error;
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts", "all"] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

/** Update a contact's editable fields. */
export function useUpdateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, values }: { id: string; values: ContactFormValues }) => {
      const supabase = createClient();
      const { error } = await supabase.from("contacts").update(normalizeChannels(values)).eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: ["contacts", "all"] });
      qc.invalidateQueries({ queryKey: ["contact", id] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

/** Delete a standalone contact. */
export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("contacts").delete().eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts", "all"] });
      toast.success("Contact deleted");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}
