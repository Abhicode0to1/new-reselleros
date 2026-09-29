/**
 * S34 — browser side of /api/leads/indiamart, for /marketing/indiamart.
 *
 * Lives beside the rest of the IndiaMART code (lib/leads) rather than in the shared
 * lib/queries folder. The key goes out in exactly one request body (POST) and is never put
 * in a query key, a URL, a toast or a console line; nothing here reads it back.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import type { IndiamartKeyStatus } from "./indiamart-key";

export const INDIAMART_KEY_QUERY = ["leads", "indiamart-key"] as const;

/** Error carrying the HTTP status, so the page can tell "not the owner" from "server broke". */
export class IndiamartApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function call<T>(method: "GET" | "POST" | "DELETE", body?: unknown): Promise<T> {
  const res = await fetch("/api/leads/indiamart", {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    throw new IndiamartApiError(typeof json?.error === "string" ? json.error : "IndiaMART setting ka server se jawab nahi aaya — page refresh karke dobara try kariye.", res.status);
  }
  return json as T;
}

export function useIndiamartKeyStatus() {
  return useQuery({
    queryKey: INDIAMART_KEY_QUERY,
    queryFn: () => call<IndiamartKeyStatus>("GET"),
    // A 403 (not the owner) will not turn into a 200 by asking again.
    retry: (n, e) => !(e instanceof IndiamartApiError && e.status < 500) && n < 2,
  });
}

export function useSaveIndiamartKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (crmKey: string) => call<{ encrypted: boolean }>("POST", { crm_key: crmKey }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: INDIAMART_KEY_QUERY });
      if (r.encrypted) toast.success("IndiaMART key save ho gayi — agle pull se leads aane lagengi");
      else toast.warning("Key save hui, par encrypt nahi hui", { description: "Server par SECRETS_MASTER_KEY set nahi hai — admin se set karwaiye, phir key dobara save kariye." });
    },
    onError: (e) => toastError(e, { description: "Key save nahi hui. Key dobara copy karke paste kariye; baar-baar ho to page refresh kariye." }),
  });
}

export function useRemoveIndiamartKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => call<Record<string, never>>("DELETE"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: INDIAMART_KEY_QUERY });
      toast.success("IndiaMART key hata di — ab naye pull nahi honge", { description: "Pehle aayi leads jaisi thi waisi rahengi." });
    },
    onError: (e) => toastError(e, { description: "Key abhi bhi saved hai. Page refresh karke dobara try kariye." }),
  });
}
