/**
 * Tooltip — accessible hover/focus tooltip (Radix-based).
 *
 * Wrap the app once in <TooltipProvider> (we do this in app layout).
 *
 * @example
 * <Tooltip>
 *   <TooltipTrigger asChild><IconButton icon="settings" aria-label="Settings" /></TooltipTrigger>
 *   <TooltipContent>Settings</TooltipContent>
 * </Tooltip>
 */
"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/ui/kbd";
import { findShortcut, type ShortcutId } from "@/lib/keyboard/shortcuts";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

export interface TooltipContentProps
  extends React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> {
  /**
   * Id of a shortcut in SHORTCUTS. Draws its keys as a badge after the text.
   *
   * ─── WHY AN ID AND NOT THE KEYS ─────────────────────────────────────────
   * The keys come from the registry, so changing a shortcut updates every tooltip that
   * mentions it. Passing the keys here instead would put a second copy in the markup,
   * which is the drift the registry was built to end — and a tooltip is the worst place
   * for it, because a wrong badge is an instruction the operator cannot follow, and they
   * conclude the shortcut is broken rather than the label.
   *
   * The type is derived from the registry, so an id that does not exist will not compile.
   */
  shortcut?: ShortcutId;
}

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  TooltipContentProps
>(({ className, sideOffset = 4, shortcut, children, ...props }, ref) => {
  const hint = shortcut ? findShortcut(shortcut) : null;
  return (
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 overflow-hidden rounded-md bg-ink text-paper px-2.5 py-1 text-xs shadow-md",
        hint && "flex items-center gap-2",
        "animate-in fade-in-0 zoom-in-95",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2",
        "data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className
      )}
      {...props}
    >
      {children}
      {hint && (
        /* Inverted surface: the tooltip is dark, so the badge borrows the tooltip's own
           text colour rather than <Kbd>'s default light-background styling. */
        <Kbd
          keys={hint.keys}
          sequence={hint.keys.length === 2 && !/^(Ctrl|Alt|Shift)$/.test(hint.keys[0])}
          className="border-paper/30 bg-paper/10 text-paper"
        />
      )}
    </TooltipPrimitive.Content>
  );
});
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
