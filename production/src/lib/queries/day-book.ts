/**
 * Day Book + MSME payables — S33 ke read hooks. Dono SQL functions (migration
 * 20260928120000) par, SECURITY INVOKER + tenant filter; yahan koi table seedha nahi padhta.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { rpcValueOrThrow } from "@/lib/accounting/report-rpc";
import type { DayBookRow } from "@/lib/accounting/day-book";

export function useDayBook(range: { from: string; to: string }, enabled = true) {
  return useQuery({
    queryKey: ["accounting", "day-book", range.from, range.to],
    enabled,
    queryFn: async (): Promise<DayBookRow[]> => {
      const supabase = createClient();
      const res = await supabase.rpc("report_day_book", { p_from: range.from, p_to: range.to });
      return rpcValueOrThrow<DayBookRow[]>(res, "report_day_book");
    },
    staleTime: 15_000,
  });
}

/** `msme_payables_aging` ki ek row. */
export interface MsmePayable {
  vendor_id: string;
  vendor_name: string;
  udyam: string;
  msme_category: "micro" | "small" | null;
  source: "vendor_bill" | "expense";
  doc_id: string;
  bill_ref: string;
  bill_date: string;
  amount_due: number;
  days_outstanding: number;
  deadline: string;
  over_limit: boolean;
}

export function useMsmePayables() {
  return useQuery({
    queryKey: ["accounting", "msme-payables"],
    queryFn: async (): Promise<MsmePayable[]> => {
      const supabase = createClient();
      const res = await supabase.rpc("msme_payables_aging", {});
      /* RETURNS TABLE → array; khaali [] ek sahi jawab hai (koi MSME bakaya nahi), null nahi. */
      return rpcValueOrThrow<MsmePayable[]>(res, "msme_payables_aging");
    },
    staleTime: 30_000,
  });
}
