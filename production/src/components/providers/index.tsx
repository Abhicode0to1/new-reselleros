/**
 * Providers — single wrapper for all top-level providers.
 * Mount once in root layout.
 */
"use client";

import { ThemeProvider } from "./theme-provider";
import { QueryProvider } from "./query-provider";
import { ConfirmProvider } from "./confirm-provider";
import { LossReasonProvider } from "./loss-reason-provider";
import { WorkspaceTabsProvider } from "./workspace-tabs-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <QueryProvider>
        {/* WorkspaceTabsProvider sits INSIDE ConfirmProvider because closing a tab
            with unsaved changes asks first, via useConfirm. Above it, that hook
            would throw on the first draft close — and only then. */}
        <ConfirmProvider>
          <WorkspaceTabsProvider>
            <LossReasonProvider>
              <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
            </LossReasonProvider>
          </WorkspaceTabsProvider>
        </ConfirmProvider>
      </QueryProvider>
    </ThemeProvider>
  );
}
