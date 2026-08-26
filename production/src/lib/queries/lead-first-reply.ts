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

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { OUTBOUND_KINDS } from "@/lib/leads/waiting";

/** `lead_id` → pehla outbound touch ka ISO timestamp. */
export type FirstReplyMap = ReadonlyMap<string, string>;

export function useLeadFirstReplies() {
  return useQuery({
    queryKey: ["lead-first-replies"],
    queryFn: async (): Promise<FirstReplyMap> => {
      const supabase = createClient();
      /* Sirf do column, aur sirf outbound kinds — RLS tenant khud sambhalta hai.
         `order` + pehla-jeeta wala reduce, `min()` group-by ke bajaye: PostgREST me
         aggregate ke liye ek view ya RPC chahiye hota, aur is naap par (aaj 10 rows, saal
         bhar me hazaar) do column ka select usse sasta hai. */
      const { data, error } = await supabase
        .from("lead_activities")
        .select("lead_id, created_at")
        .in("kind", [...OUTBOUND_KINDS])
        .order("created_at", { ascending: true });
      if (error) throw error;

      const map = new Map<string, string>();
      for (const row of data ?? []) {
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
