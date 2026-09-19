"use client";

/**
 * "Which workspace am I in?" — asked once, answered once.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Traced on 12 Sep 2026 from a complaint that every page felt laggy. One load of
 * /dashboard made 104 Supabase calls, and 21 of them were two questions asked
 * over and over: `GET /auth/v1/user` eleven times and `GET /rest/v1/users` ten.
 *
 * The cause was that 29 modules under src/lib/queries each opened with their own
 * copy of this preamble before getting to the query they were actually for:
 *
 *     const { data: authData } = await supabase.auth.getUser();     // round-trip 1
 *     const { data: me } = await supabase
 *       .from("users").select("tenant_id").eq("id", authData.user.id).single();
 *                                                                   // round-trip 2
 *
 * Two round-trips per hook, before its real work starts. `projects.ts` did it
 * three times by itself. `useTenantId` asks under one React Query key, so every
 * caller in a render shares a single answer.
 *
 * ─── AND IT REFUSES TO GUESS ────────────────────────────────────────────────
 * Each copy of that preamble also carried a fallback:
 *
 *     let tenantId = "11111111-1111-1111-1111-111111111111"; // default dev/demo tenant
 *
 * which meant a write whose identity lookup failed did not stop — it inserted
 * the row against a hardcoded tenant. tenant_id is the column that decides who
 * may read a row, so it is the one value in this schema that must never have a
 * default. `resolveTenantId` throws instead, and says which of the two things
 * went wrong so the caller can tell "signed out" from "no workspace yet".
 */

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

/** Shared key — this is what makes the duplicate calls collapse into one. */
export const TENANT_ID_KEY = ["tenant-id"] as const;

/** The two calls `resolveTenantId` needs, and nothing else, so it is testable. */
type IdentityClient = {
  auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> };
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        single: () => Promise<{ data: { tenant_id: string | null } | null; error: { message: string } | null }>;
      };
    };
  };
};

/**
 * The signed-in user's tenant, or an error explaining why there isn't one.
 *
 * Throws — never returns a placeholder. Callers writing rows must let it throw:
 * refusing the write is correct, and a row in the wrong tenant is not.
 */
export async function resolveTenantId(supabase: IdentityClient): Promise<string> {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    throw new Error("Your session has expired. Sign in again to save this.");
  }

  const { data, error } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", authData.user.id)
    .single();

  if (error) {
    throw new Error(`Could not read your workspace: ${error.message}`);
  }
  if (!data?.tenant_id) {
    /* A real state, not a fault: signed in, but not a member of a workspace yet
       (the "stranded" case the staff sidebar names). Says what to do about it. */
    throw new Error("Your account isn't in a workspace yet — ask an owner to add you.");
  }
  return data.tenant_id;
}

/**
 * The hook form. Every caller in one render shares a single request, because
 * they share `TENANT_ID_KEY`.
 *
 * `staleTime: Infinity` because a user's tenant does not change while the tab is
 * open — moving workspaces means signing in again, which resets the cache.
 * `retry: false` because both failure modes here are answers, not blips: an
 * expired session and an account with no workspace are both states the reader
 * has to act on, and retrying either just delays telling them.
 */
export function useTenantId() {
  return useQuery({
    queryKey: TENANT_ID_KEY,
    queryFn: () => resolveTenantId(createClient() as unknown as IdentityClient),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
}
