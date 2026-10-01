/**
 * R-009 — credit / debit note totals for every invoice of the tenant, in ONE query
 * (two small selects run together), so the invoices list never fires a query per row.
 * RLS scopes both tables to the tenant.
 *
 * The key sits under ["invoices", …] on purpose: issuing a credit or debit note
 * already invalidates ["invoices"], so the list refreshes with no extra wiring.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { noteTotalsByInvoice, type NoteAmountRow, type NoteTotals } from "@/lib/invoices/note-totals";

export function useInvoiceNoteTotals() {
  return useQuery({
    queryKey: ["invoices", "note-totals"],
    queryFn: async (): Promise<Map<string, NoteTotals>> => {
      const supabase = createClient();
      const [credit, debit] = await Promise.all([
        fetchAllRows<NoteAmountRow>((from, to) =>
          supabase.from("credit_notes").select("invoice_id, amount").order("id", { ascending: true }).range(from, to),
        ),
        fetchAllRows<NoteAmountRow>((from, to) =>
          supabase.from("debit_notes").select("invoice_id, amount").order("id", { ascending: true }).range(from, to),
        ),
      ]);
      return noteTotalsByInvoice(credit, debit);
    },
  });
}
