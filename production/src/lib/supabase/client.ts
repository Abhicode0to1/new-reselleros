/**
 * Supabase BROWSER client — for client components.
 *
 * Uses cookies for session storage so it shares auth state with the server client.
 *
 * @example In a "use client" component:
 *   const supabase = createClient();
 *   const { data } = await supabase.from("leads").select("*");
 */
import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./database.types";

/**
 * NEXT_PUBLIC_DATA_GATEWAY=1: database requests (/rest/v1) go to this app's own
 * /api/sb/rest/v1 (Prisma gateway, src/server/postgrest) instead of the VM's PostgREST. The
 * session token travels exactly as before; auth and storage still go to the VM for now.
 */
function rewriteRest(input: RequestInfo | URL): RequestInfo | URL {
  if (process.env.NEXT_PUBLIC_DATA_GATEWAY !== "1" || typeof window === "undefined") return input;
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "") + "/rest/v1/";
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!href.startsWith(base)) return input;
  return window.location.origin + "/api/sb/rest/v1/" + href.slice(base.length);
}

export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Force fresh reads — the browser-side twin of the same rule on
      // createAdminClient() (see server.ts, and CLAUDE.md §17).
      //
      // Supabase's REST responses carry NO `Cache-Control` and NO `Vary: Origin`.
      // Both halves of that bite:
      //
      //   1. STALE DATA. With no Cache-Control the browser is free to heuristically
      //      cache a 200, so a balance or a payment status can be served from disk
      //      instead of the DB. React Query is already the caching layer here; the
      //      HTTP cache underneath it is redundant AND capable of lying.
      //
      //   2. CROSS-ORIGIN CORS POISONING. With no `Vary: Origin` the cache key is
      //      just the URL, and Supabase ECHOES the request Origin into
      //      Access-Control-Allow-Origin. So a response cached while browsing
      //      http://localhost:3000 is replayed to the deployed origin carrying
      //      `Access-Control-Allow-Origin: http://localhost:3000`, and every
      //      client-side query fails CORS — on a build with nothing wrong with it.
      //      Observed 14 Aug 2026 on the Cloud Run app: /leads hit the error
      //      boundary because the currentUser query could not complete. Only a
      //      dev/staff machine can reach that state (a customer never visits
      //      localhost), which is exactly why it wastes a debugging session
      //      instead of showing up in monitoring.
      global: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(rewriteRest(input), { ...init, cache: "no-store" }),
      },
    },
  );
}

/** Inferred type of our browser client (for explicit annotations) */
export type TypedSupabaseBrowser = ReturnType<typeof createClient>;

/** True if Supabase env vars look configured (not placeholder values). */
export function isSupabaseConfigured(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return Boolean(
    url &&
    key &&
    !url.includes("your-project") &&
    key.length > 20
  );
}
