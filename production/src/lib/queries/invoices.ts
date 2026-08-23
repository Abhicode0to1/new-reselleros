/**
 * Invoices — TanStack Query hooks.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SeriesState } from "@/lib/actions/consequence";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import { grossAmount, isQuoteAmountConsistent } from "@/lib/quotes/amounts";
import type { Invoice } from "@/lib/supabase/database.types";

// ============================================================
// List
// ============================================================
export function useInvoices(filter?: { status?: Invoice["status"] | "all" }) {
  return useQuery({
    queryKey: ["invoices", filter?.status ?? "all"],
    queryFn: async (): Promise<Invoice[]> => {
      const supabase = createClient();
      let q = supabase
        .from("invoices")
        .select("*")
        .order("invoice_date", { ascending: false });
      if (filter?.status && filter.status !== "all") {
        q = q.eq("status", filter.status);
      }
      const { data, error } = await q;
      if (error) {
        console.warn("Supabase invoices query error:", error.message);
        return [];
      }
      return data ?? [];
    },
  });
}

export function useCustomerInvoices(customerId: string | undefined) {
  return useQuery({
    queryKey: ["invoices", "customer", customerId],
    enabled: !!customerId,
    queryFn: async (): Promise<Invoice[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("invoices")
        .select("*")
        .eq("customer_id", customerId!)
        .order("invoice_date", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

// ============================================================
// Quotes awaiting GST invoice — partial OR fully-paid, no invoice yet
//
// Legal context: CGST Section 13(2) — supply trigger for services =
// earlier of invoice OR payment. So as soon as a partial advance is
// received, the 30-day invoicing clock starts (Rule 47). We MUST allow
// invoice generation in 'partial' state, not just 'received'.
//
// Aging is computed from the FIRST payment (advance receipt) on the
// quote — not the last — because that's when the legal clock started.
// ============================================================
export function useQuotesAwaitingInvoice() {
  return useQuery({
    queryKey: ["quotes", "awaiting-invoice"],
    queryFn: async () => {
      const supabase = createClient();

      // Both partial AND fully-paid quotes need invoicing within 30 days of first advance
      const { data: quotes, error } = await supabase
        .from("quotes")
        .select(
          "id, customer_id, customer_name, amount, payment_amount, payment_received_at, payment_method, lead_id, payment_status, payment_terms_days",
        )
        .in("payment_status", ["partial", "received"])
        .is("invoice_id", null);
      if (error) throw error;
      if (!quotes || quotes.length === 0) return [];

      // Fetch the earliest received payment per quote — legal aging anchor
      const quoteIds = quotes.map((q) => q.id);
      const { data: payments, error: pErr } = await supabase
        .from("payments")
        .select("quote_id, received_at")
        .in("quote_id", quoteIds)
        .eq("status", "received")
        .order("received_at", { ascending: true });
      if (pErr) throw pErr;

      const firstAdvanceByQuote = new Map<string, string>();
      for (const p of payments ?? []) {
        if (!firstAdvanceByQuote.has(p.quote_id)) {
          firstAdvanceByQuote.set(p.quote_id, p.received_at);
        }
      }

      // Decorate each quote with its first_advance_at; sort by oldest first (most urgent)
      return quotes
        .map((q) => ({
          ...q,
          first_advance_at: firstAdvanceByQuote.get(q.id) ?? q.payment_received_at ?? null,
        }))
        .sort((a, b) => {
          if (!a.first_advance_at) return 1;
          if (!b.first_advance_at) return -1;
          return a.first_advance_at.localeCompare(b.first_advance_at);
        });
    },
  });
}

// ============================================================
// Generate GST invoice from a quote — with advance adjustment
//
// Legal flow (CGST Section 31 + Rule 53):
//   1. Allocate next sequential invoice number via RPC (race-safe)
//   2. Snapshot all received payments → adjusted_advances jsonb (frozen)
//   3. net_payable = amount - sum(advances), floor 0
//   4. status determined by net_payable: 0 → "paid", >0 → "pending"
//   5. Quote moves to payment_status='invoiced' (terminal state from quote POV)
//
// Idempotency:
//   - Quotes already have invoice_id? Refuse — one quote, one invoice.
//   - Future: split-invoicing support would loosen this (separate task).
// ============================================================
export function useGenerateInvoice() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (quoteId: string) => {
      const supabase = createClient();

      /* Pre-flight: refuse a quote whose own numbers disagree.
         `generate_invoice` copies `quotes.amount` onto the invoice as-is, and a tax
         invoice is not editable afterwards — so a quote storing ₹45,360 while its 18%
         rate says ₹53,525 would become a GST document under-charging ₹8,165, silently.
         Measured 21 Aug 2026: exactly one of 27 production quotes is in this state
         (Q-2026-9776), so this blocks the broken row and nothing else. §24 — say what,
         why, and the next step. */
      const check = await supabase
        .from("quotes")
        .select("subtotal, tax_rate, amount")
        .eq("id", quoteId)
        .single();
      if (check.error) throw check.error;
      const { subtotal, tax_rate, amount } = check.data;
      if (!isQuoteAmountConsistent(subtotal ?? 0, tax_rate ?? 0, amount ?? 0)) {
        const should = grossAmount(subtotal ?? 0, tax_rate ?? 0);
        throw new Error(
          `Is quote ka total apne hi GST se mel nahi khata — invoice nahi ban sakti. `
          + `Subtotal ₹${(subtotal ?? 0).toLocaleString("en-IN")} par ${tax_rate ?? 0}% GST = `
          + `₹${should.toLocaleString("en-IN")}, par quote me ₹${(amount ?? 0).toLocaleString("en-IN")} likha hai `
          + `(₹${Math.abs(should - (amount ?? 0)).toLocaleString("en-IN")} ka farak). `
          + `Invoice banne ke baad ye number badla nahi ja sakta. Pehle quote edit karke total theek karo — `
          + `ya agar daam GST-sahit tay hua tha to tax rate theek karo — phir invoice banao.`,
        );
      }

      // Atomic, tenant-safe invoice generation — one SECURITY DEFINER
      // transaction (migration 0058 `generate_invoice`). Replaces the old
      // 6-step client chain (load quote → compute advances → allocate number
      // → insert invoice → mark quote invoiced) which could race two
      // concurrent clicks (#8) or leave the quote un-marked if a mid-flight
      // write failed (#9). The RPC locks the quote (FOR UPDATE), freezes the
      // advance snapshot, and commits the invoice + quote update together.
      const { data, error } = await supabase.rpc("generate_invoice", {
        p_quote_id: quoteId,
      });
      if (error) throw error;

      const row = data?.[0];
      if (!row) throw new Error("Invoice generation returned no result");

      return {
        invoiceId:     row.invoice_id,
        netPayable:    row.net_payable,
        totalAdvances: row.total_advances,
      };
    },
    onSuccess: ({ invoiceId, netPayable, totalAdvances }) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      if (totalAdvances > 0 && netPayable > 0) {
        toast.success(
          `Invoice ${invoiceId} generated · ₹${totalAdvances.toLocaleString("en-IN")} advance adjusted · ₹${netPayable.toLocaleString("en-IN")} payable`,
        );
      } else if (netPayable === 0) {
        toast.success(`Invoice ${invoiceId} generated · fully settled by advances`);
      } else {
        toast.success(`Invoice ${invoiceId} generated · ₹${netPayable.toLocaleString("en-IN")} payable`);
      }
    },
    onError: (err) => toastError(err),
  });
}

// ============================================================
// Direct (one-off) invoice — raise a GST invoice straight against a customer
// (setup fee, ad-hoc service). Creates a one-off quote (no subscription) then
// generate_invoice, atomically (migration 0158 create_direct_invoice).
// ============================================================
export interface DirectInvoiceLine {
  name: string;
  qty:  number;
  rate: number;   // ex-GST ₹ per unit
}

export function useCreateDirectInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { customerId: string; lines: DirectInvoiceLine[]; notes?: string | null; recurring?: boolean }) => {
      const supabase = createClient();
      // The RPC stamps the correct commitment; we just pass the raw line shape.
      const lineItems = input.lines.map((l, i) => ({
        id:   `line-${i + 1}`,
        name: l.name,
        qty:  l.qty,
        rate: l.rate,
        cost: 0,
      }));
      const { data, error } = await supabase.rpc("create_direct_invoice", {
        p_customer_id: input.customerId,
        p_line_items:  lineItems,
        p_notes:       input.notes ?? null,
        p_recurring:   input.recurring ?? false,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return row as { invoice_id: string; quote_id: string; net_payable: number; tax_rate: number };
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["aging"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      toast.success(
        `Invoice ${res.invoice_id} raised · ₹${res.net_payable.toLocaleString("en-IN")} due${res.tax_rate === 0 ? " · export (zero-rated)" : ""}`,
      );
    },
    onError: (err) => toastError(err),
  });
}

/**
 * Delete a PROJECT invoice + everything tied to it (payments, bank reconcile,
 * milestone reset, number roll-back) atomically via delete_project_invoice.
 * Only valid for project-milestone invoices.
 */
export function useDeleteProjectInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("delete_project_invoice", { p_invoice_id: invoiceId });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["project_sales"] });
      qc.invalidateQueries({ queryKey: ["project_payments"] });
      qc.invalidateQueries({ queryKey: ["project_milestones"] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      toast.success("Project invoice deleted — payment reversed, milestone re-opened");
    },
    onError: (err) => toastError(err),
  });
}

/**
 * Delete a SUBSCRIPTION (quote-generated) invoice — SAFE reversal via
 * delete_subscription_invoice: removes the GST document + re-opens the quote
 * for re-invoicing. Does NOT touch payments / subscriptions.
 */
export function useDeleteSubscriptionInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("delete_subscription_invoice", { p_invoice_id: invoiceId });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      toast.success("Invoice deleted — quote re-opened for re-invoicing");
    },
    onError: (err) => toastError(err),
  });
}

export function useCustomerQuotes(customerId: string | undefined) {
  return useQuery({
    queryKey: ["quotes", "customer", customerId],
    enabled: !!customerId,
    queryFn: async (): Promise<any[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("quotes")
        .select("*")
        .eq("customer_id", customerId!)
        .order("created_date", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * The tenant's document counters, for the pre-action confirmations.
 *
 * Read-only and deliberately so: `next_document_number` is the ONLY thing allowed to
 * allocate (CLAUDE.md §17a), so this reads `last_number` to PREDICT the next value and
 * never touches it. A concurrent issue can take the predicted number first, which is why
 * the dialogs call it a prediction rather than a promise.
 *
 * `documentCount` comes back alongside so a confirmation can spot a series with holes —
 * ANUTECH sits at 32 with zero invoices and at 39 with zero payments, and an operator
 * about to add to either should see it.
 */
export interface DocumentSeriesPair {
  invoice: SeriesState | null;
  receiptVoucher: SeriesState | null;
}

/**
 * Both document counters the pre-action dialogs need.
 *
 * Through a route, not the browser client: `document_series` is absent from the generated
 * Database type, and registering it there took typecheck from 4 errors to 2,722 — see
 * api/invoices/series/route.ts for why the table stays unregistered.
 */
export function useDocumentSeries() {
  return useQuery({
    queryKey: ["document-series"],
    queryFn: async (): Promise<DocumentSeriesPair> => {
      const res = await fetch("/api/invoices/series");
      /* Empty rather than a throw. A missing counter must not stop a dialog opening —
         it degrades to "this opens the series" wording and the operator still gets the
         irreversibility warnings, which are the part that matters. */
      if (!res.ok) return { invoice: null, receiptVoucher: null };
      const json = await res.json() as Partial<DocumentSeriesPair>;
      return { invoice: json.invoice ?? null, receiptVoucher: json.receiptVoucher ?? null };
    },
    /* The numbers move whenever anyone issues, so a stale prediction is a wrong one. */
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}
