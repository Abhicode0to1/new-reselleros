"use client";

/**
 * The click-to-sign record for a quote.
 *
 * Read-only by design. A signature is evidence of what a named person confirmed at a
 * moment in time — an app that can edit one has evidence of nothing. Rows are written
 * only by the public accept route, through the service role.
 */
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { QuoteSignature } from "@/lib/supabase/database.types";

export function useQuoteSignature(quoteId: string | undefined) {
  return useQuery({
    queryKey: ["quote-signature", quoteId],
    enabled: Boolean(quoteId),
    queryFn: async (): Promise<QuoteSignature | null> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("quote_signatures")
        .select("*")
        .eq("quote_id", quoteId!)
        /* Newest first: a quote re-sent and re-confirmed has more than one, and the
           latest is the one that describes what was actually agreed. The earlier rows
           stay — deleting superseded evidence is how an audit trail becomes a claim. */
        .order("signed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}
