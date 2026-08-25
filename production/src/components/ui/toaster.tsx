/**
 * Toaster — global toast provider using sonner.
 * Mount this in the root layout. Then use `toast()` anywhere.
 *
 * @example In root layout:
 * <Toaster />
 *
 * @example In any client component:
 * import { toast } from "sonner";
 *
 * toast("Quote sent");
 * toast.success("Payment received");
 * toast.error("Could not save");
 * toast.promise(saveQuote(), {
 *   loading: "Saving…",
 *   success: "Quote saved",
 *   error: "Save failed",
 * });
 */
"use client";

import { Toaster as SonnerToaster } from "sonner";

export function Toaster() {
  return (
    <SonnerToaster
      position="top-right"
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast: "border border-hairline shadow-md bg-paper text-ink",
          title: "font-medium text-sm",
          description: "text-xs text-ink-3",
          success: "!bg-emerald-soft !text-emerald !border-emerald/20",
          error: "!bg-rose-soft !text-rose-ink !border-rose/20",
          warning: "!bg-amber-soft !text-amber-ink !border-amber/20",
          info: "!bg-indigo-soft !text-indigo-ink !border-indigo/20",
        },
      }}
    />
  );
}

// Re-export `toast` from sonner so callers can do `import { toast } from "@/components/ui/toaster"`
export { toast } from "sonner";
