/**
 * Har lead ka PEHLA outbound touch — poori list ke liye, ek query me.
 *
 * ─── KYUN EK ALAG HOOK ──────────────────────────────────────────────────────
 * `useLeadActivities` ek lead ka poora timeline laata hai; wo drawer ke liye theek hai.
 * List ke liye wo galat shakl hai — 50 leads ka matlab 50 query. Yahan sirf EK cheez
 * chahiye (pehla jawab kab gaya) aur wo ek hi query me nikal aati hai.
 *
 * ─── AUR YE COLUMN BANANE SE BEHTAR KYUN HAI ────────────────────────────────
 * 26 Aug 2026 ko maine pehle daawa kiya tha ki iske liye `leads.first_responded_at`
 * column banana padega, warna response time "hamesha ke liye kho jayega". Query chalakar
 * wo galat nikla: `lead_activities` ye pehle se likhti hai. Ek nayi column ka matlab
 * hota ek migration, ek backfill, aur do jagah se ek hi sach — jabki jawab pehle se
 * maujood tha.
 */
"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { OUTBOUND_KINDS } from "@/lib/leads/waiting";
import { fetchAllRowsIn, idsKey } from "@/lib/ops/fetch-all";

/** `lead_id` → pehla outbound touch ka ISO timestamp. */
export type FirstReplyMap = ReadonlyMap<string, string>;

/**
 * WC-scale (30 Sep 2026): for THESE leads only — the rows on screen. It read every outbound
 * activity in the tenant, oldest first, and PostgREST's 1000-row cap kept the OLDEST
 * thousand: every lead created after them read as "never replied to". Now 200 lead ids a
 * request, every page read (lib/ops/fetch-all.ts); the (tenant_id, kind, created_at) index
 * (migration 20260930110000) serves the kind + order.
 */
export function useLeadFirstReplies(leadIds: readonly string[]) {
  const ids = idsKey(leadIds);
  return useQuery({
    queryKey: ["lead-first-replies", ids],
    enabled: ids.length > 0,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<FirstReplyMap> => {
      const supabase = createClient();
      /* Sirf do column, aur sirf outbound kinds — RLS tenant khud sambhalta hai.
         `order` + pehla-jeeta wala reduce, `min()` group-by ke bajaye: PostgREST me
         aggregate ke liye ek view ya RPC chahiye hota, aur is naap par (aaj 10 rows, saal
         bhar me hazaar) do column ka select usse sasta hai. */
      const data = await fetchAllRowsIn(ids, (chunkIds, from, to) => supabase
        .from("lead_activities")
        .select("lead_id, created_at")
        .in("lead_id", chunkIds)
        .in("kind", [...OUTBOUND_KINDS])
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to));

      const map = new Map<string, string>();
      for (const row of data) {
        const id = row.lead_id;
        /* Pehla jeeta: list `created_at` ke kram me hai, to jo pehle mila wahi sabse
           purana hai. `has` ki jaanch zaroori hai — bina uske aakhri wala jeet jata aur
           speed-to-lead ki jagah "aakhri baar kab baat hui" mil jata. */
        if (id && !map.has(id)) map.set(id, row.created_at);
      }
      return map;
    },
    /* 30s: ye number minute me badalta hai, second me nahi — aur chip dabane par
       invalidate waise bhi ho jata hai. */
    staleTime: 30_000,
  });
}
