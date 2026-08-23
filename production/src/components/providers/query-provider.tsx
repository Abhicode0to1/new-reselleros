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
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";

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
      {/* ── DEVTOOLS TOGGLE, MOVED OFF THE CONTROLS IT WAS SITTING ON ─────────
          Reported 23 Aug 2026 as "the avatar overlaps the bottom bar", and it is not an
          avatar — it is this button, whose default artwork is a round colour emblem that
          reads as a profile photo at a glance. I had spun off a task to fix the sidebar
          before checking; the sidebar is correctly gated `hidden md:flex` and was never on
          screen. Worth recording as a diagnosis error, not just a fix.

          It never reaches a customer — NODE_ENV gates it, and it is absent from the
          production bundle. But it covered a real control at every width, which matters
          because these are the widths browser verification runs at, and covering the very
          button you are trying to click is how a dev-only overlay becomes a wrong bug
          report:

            bottom-left at <md  → MobileBottomNav's first item, and the lead drawer
                                  footer's Call button — a 44px target per §20 that was
                                  partly unreachable
            bottom-left at md+  → the sidebar's user chip, which is a DropdownMenuTrigger

          `top-left` at md+ lands on the sidebar brand block, a plain div with no handler,
          and the tenant name beside it stays readable. Below md it is hidden outright:
          every mobile corner holds something real — hamburger, bell, bottom nav, FAB — so
          there is no free corner to move it to, and a debug affordance does not get to
          outrank an app control.

          THE COST: no devtools on a narrow window. Widen the window to get them back. */}
      {process.env.NODE_ENV === "development" && (
        <div className="hidden md:block">
          <ReactQueryDevtools initialIsOpen={false} buttonPosition="top-left" />
        </div>
      )}
    </QueryClientProvider>
  );
}
