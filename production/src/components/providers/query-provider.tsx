/**
 * QueryProvider — wraps TanStack Query for client-side data fetching.
 *
 * Sensible defaults:
 * - staleTime: 30 seconds (avoid refetches on every navigation)
 * - retry: 1 attempt on failure
 * - refetchOnWindowFocus: disabled (annoying for SaaS apps)
 */
"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export function QueryProvider({ children }: { children: React.ReactNode }) {
  // Single QueryClient instance per render — created lazily inside the component
  // so we don't share data between SSR requests.
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30 * 1000,
            gcTime: 5 * 60 * 1000,
            retry: 1,
            refetchOnWindowFocus: false,
            refetchOnReconnect: true,
          },
          mutations: {
            retry: 0,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {/* ── NO DEVTOOLS TOGGLE HERE, ON PURPOSE (removed 21 Sep 2026) ─────────
          `<ReactQueryDevtools>` used to render here. Its floating button's default
          artwork is a round palm-tree emblem, and over three separate reports it was
          mistaken for something in the app every time: "the avatar overlaps the bottom
          bar" (23 Aug — it is not an avatar, and the sidebar I went to fix was correctly
          `hidden md:flex` and never on screen), "logo show nahi kar raha" twice (26 Aug —
          it sat on the brand mark and read as the company logo), and finally "remove this
          icon, don't need it interfering with our ui".

          It was moved twice before being removed. Moving it kept failing because every
          corner of this app holds something real — hamburger, bell, bottom nav, FAB,
          sidebar brand block, the user chip — so there was no free corner, and a debug
          affordance does not get to outrank an app control.

          It never reached a customer: NODE_ENV gated it and it was absent from the
          production bundle. The cost it kept charging was in dev, where it made people
          ask the wrong question about their own UI — and a wrong bug report costs a real
          session. See AGENTS.md L53.

          THE COST OF REMOVING IT: no query inspector in the browser. React Query itself
          is untouched; `@tanstack/react-query-devtools` is still a devDependency, so
          re-adding is this import plus one element. If you do, do not put it back on a
          corner that holds a control. */}
    </QueryClientProvider>
  );
}
