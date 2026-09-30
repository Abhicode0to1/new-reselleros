/**
 * Deal detail page — the rows behind "Poori history" that the lead drawer does not already
 * read (30 Sep 2026). lib/deals/timeline.ts merges them; this only fetches.
 *
 * Links used (all real columns, read under the caller's RLS):
 *   lead  → inbound_emails.lead_id, whatsapp_messages.related_lead_id, ai_telecall_logs.lead_id,
 *           activity_log (entity 'leads', entity_id = lead id)
 *   quote → quote_send_log / quote_views / quote_signatures .quote_id,
 *           invoices.quote_id (+ quotes.invoice_id), payments.quote_id, subscriptions.quote_id,
 *           activity_log (entity 'quotes', entity_id = quote id)
 * Invoices / subscriptions of the lead's CUSTOMER are deliberately not read: a customer can
 * have many deals, and nothing on those rows says which deal they belong to.
 *
 * Each source is read on its own and may fail on its own (a role without access to one
 * table still sees the rest); the failed ones are named so the page can say so.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { idsKey } from "@/lib/ops/fetch-all";
import { isSentReply } from "@/lib/inbound/sent";
import type { DealHistorySources } from "@/lib/deals/timeline";

type Rows<K extends keyof DealHistorySources> = NonNullable<DealHistorySources[K]>;

async function safe<T>(label: string, failed: string[], run: () => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[] | undefined> {
  try {
    const { data, error } = await run();
    if (error) { failed.push(label); return undefined; }
    return data ?? [];
  } catch {
    failed.push(label);
    return undefined;
  }
}

/** Lead-linked sources. */
export function useDealLeadSources(leadId: string | undefined) {
  return useQuery({
    queryKey: ["deal-history", "lead", leadId],
    enabled: Boolean(leadId),
    staleTime: 15_000,
    queryFn: async () => {
      const supabase = createClient();
      const failed: string[] = [];
      const id = leadId!;
      const [mail, whatsapp, aiCalls, auditLog] = await Promise.all([
        safe("Email", failed, () => supabase.from("inbound_emails")
          .select("id, subject, from_email, from_name, to_email, status, created_at")
          .eq("lead_id", id).order("created_at", { ascending: false }).limit(500)),
        safe("WhatsApp (app)", failed, () => supabase.from("whatsapp_messages")
          .select("id, direction, text_body, type, template_name, status, created_at")
          .eq("related_lead_id", id).order("created_at", { ascending: false }).limit(500)),
        safe("AI calls", failed, () => supabase.from("ai_telecall_logs")
          .select("id, status, summary, duration_sec, created_at")
          .eq("lead_id", id).order("created_at", { ascending: false }).limit(200)),
        safe("Stage history", failed, () => supabase.from("activity_log")
          .select("id, entity, entity_id, action, changes, created_at, user_id")
          .eq("entity", "leads").eq("entity_id", id).eq("action", "update")
          .order("created_at", { ascending: false }).limit(500)),
      ]);
      const emails: Rows<"emails"> | undefined = mail?.map((e) => ({ ...e, sent: isSentReply(e) }));
      return { emails, whatsapp, aiCalls, auditLog, failed };
    },
  });
}

/** Quote-linked sources — everything that hangs off this deal's quotes. */
export function useDealQuoteSources(quotes: readonly { id: string; invoice_id?: string | null }[] | undefined) {
  const ids = idsKey((quotes ?? []).map((q) => q.id));
  const invoiceIds = idsKey((quotes ?? []).map((q) => q.invoice_id).filter((x): x is string => !!x));
  return useQuery({
    queryKey: ["deal-history", "quotes", ids, invoiceIds],
    enabled: quotes !== undefined,
    staleTime: 15_000,
    queryFn: async () => {
      const failed: string[] = [];
      if (ids.length === 0) {
        return { quoteSends: [], quoteViews: [], quoteSignatures: [], invoices: [], payments: [], subscriptions: [], auditLog: [], failed };
      }
      const supabase = createClient();
      const [quoteSends, quoteViews, quoteSignatures, invByQuote, invById, payments, subscriptions, auditLog] = await Promise.all([
        safe("Quote send log", failed, () => supabase.from("quote_send_log")
          .select("id, quote_id, sent_at, recipient_email, status, sent_by").in("quote_id", ids)),
        safe("Quote views", failed, () => supabase.from("quote_views")
          .select("id, quote_id, viewed_at, is_bot").in("quote_id", ids).limit(1000)),
        safe("Quote signatures", failed, () => supabase.from("quote_signatures")
          .select("id, quote_id, signed_at, signer_name").in("quote_id", ids)),
        safe("Invoices", failed, () => supabase.from("invoices")
          .select("id, amount, status, invoice_date, created_at, quote_id, paid_amount").in("quote_id", ids)),
        invoiceIds.length > 0
          ? safe("Invoices", failed, () => supabase.from("invoices")
              .select("id, amount, status, invoice_date, created_at, quote_id, paid_amount").in("id", invoiceIds))
          : Promise.resolve([]),
        safe("Payments", failed, () => supabase.from("payments")
          .select("id, amount, method, status, received_at, created_at, refunded_at, quote_id, recorded_by").in("quote_id", ids)),
        safe("Subscriptions", failed, () => supabase.from("subscriptions")
          .select("id, plan, seats, status, start_date, created_at, mrr, renewal_date").in("quote_id", ids)),
        safe("Quote history", failed, () => supabase.from("activity_log")
          .select("id, entity, entity_id, action, changes, created_at, user_id")
          .eq("entity", "quotes").in("entity_id", ids).eq("action", "update").limit(1000)),
      ]);
      const invoiceMap = new Map<string, NonNullable<typeof invByQuote>[number]>();
      for (const i of [...(invByQuote ?? []), ...(invById ?? [])]) invoiceMap.set(i.id, i);
      const invoices = invByQuote === undefined && invById === undefined ? undefined : [...invoiceMap.values()];
      return { quoteSends, quoteViews, quoteSignatures, invoices, payments, subscriptions, auditLog, failed: [...new Set(failed)] };
    },
  });
}

/**
 * Project-quotation sources (1 Oct 2026, "project quote bhi dikhao"). A custom-software deal
 * is quoted through Project Sales, not `quotes`, so none of the rows above reach it. The
 * chain, all real columns:
 *   leads.project_id → project_sales.id                      (create_project_quote_from_lead)
 *   project_sales.id → project_milestones.project_id → .invoice_id → invoices.id
 *   project_sales.id → project_payments.project_id           (record_project_payment writes
 *                                                             ONLY here, never to `payments`)
 * Read-only, under the caller's RLS; each source fails on its own like the ones above.
 */
export function useDealProjectSources(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ["deal-history", "project", projectId ?? null],
    enabled: projectId !== undefined,
    staleTime: 15_000,
    queryFn: async () => {
      const failed: string[] = [];
      if (!projectId) {
        return { projects: [], projectMilestones: [], projectInvoices: [], projectPayments: [], failed };
      }
      const supabase = createClient();
      const [projects, projectMilestones, projectPayments] = await Promise.all([
        safe("Project quotation", failed, () => supabase.from("project_sales")
          .select("id, title, status, total_amount, created_at, accepted_at, updated_at").eq("id", projectId)),
        safe("Project milestones", failed, () => supabase.from("project_milestones")
          .select("id, project_id, seq, label, total_amount, invoice_id").eq("project_id", projectId)),
        safe("Project payments", failed, () => supabase.from("project_payments")
          .select("id, project_id, milestone_id, amount, method, received_at, created_at").eq("project_id", projectId)),
      ]);
      const invoiceIds = idsKey((projectMilestones ?? []).map((m) => m.invoice_id).filter((x): x is string => !!x));
      const projectInvoices = projectMilestones === undefined
        ? undefined
        : invoiceIds.length === 0
          ? []
          : await safe("Project invoices", failed, () => supabase.from("invoices")
              .select("id, amount, net_payable, paid_amount, status, invoice_date, created_at, quote_id").in("id", invoiceIds));
      return { projects, projectMilestones, projectInvoices, projectPayments, failed };
    },
  });
}
