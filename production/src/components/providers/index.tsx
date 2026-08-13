/**
 * Providers — single wrapper for all top-level providers.
 * Mount once in root layout.
 */
"use client";

import { ThemeProvider } from "./theme-provider";
import { QueryProvider } from "./query-provider";
import { ConfirmProvider } from "./confirm-provider";
import { LossReasonProvider } from "./loss-reason-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <QueryProvider>
        <ConfirmProvider>
          <LossReasonProvider>
            <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
          </LossReasonProvider>
        </ConfirmProvider>
      </QueryProvider>
    </ThemeProvider>
  );
}
