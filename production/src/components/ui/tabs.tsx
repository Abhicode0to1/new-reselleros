/**
 * Tabs — accessible tab navigation built on Radix.
 *
 * Two API styles:
 *
 * 1. Headless (Radix) — for layouts with custom tab content panes
 * @example
 * <Tabs defaultValue="active">
 *   <TabsList>
 *     <TabsTrigger value="active">Active <TabBadge>14</TabBadge></TabsTrigger>
 *     <TabsTrigger value="expired">Expired</TabsTrigger>
 *   </TabsList>
 *   <TabsContent value="active">...</TabsContent>
 * </Tabs>
 *
 * 2. Simple — like prototype's <Tabs> with count badges
 * @example
 * <TabBar
 *   value={tab}
 *   onChange={setTab}
 *   items={[
 *     { id: "all",      label: "All",      count: 24 },
 *     { id: "active",   label: "Active",   count: 14, dot: "emerald" },
 *     { id: "expired",  label: "Expired",  count: 3,  dot: "rose" },
 *   ]}
 * />
 */
"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

// ============================================================
// Radix headless tabs (for complex layouts)
// ============================================================
const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex items-center gap-1 border-b border-hairline w-full",
      className
    )}
    {...props}
  />
));
TabsList.displayName = "TabsList";

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "min-h-11 md:min-h-0 relative inline-flex items-center gap-2 px-3 py-2 text-sm font-medium",
      "text-ink-3 hover:text-ink transition-colors",
      "border-b-2 border-transparent -mb-px",
      "data-[state=active]:text-ink data-[state=active]:border-amber",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2 rounded-t-md",
      "disabled:opacity-50",
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = "TabsTrigger";

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-4 focus-visible:outline-none",
      className
    )}
    {...props}
  />
));
TabsContent.displayName = "TabsContent";

// ============================================================
// Simple TabBar (matches prototype API — no content panes)
// ============================================================
export interface TabBarItem {
  id: string;
  label: string;
  count?: number;
  /** Status dot color (left of label) */
  dot?: "emerald" | "amber" | "rose" | "indigo" | "slate";
  /** Disable this tab */
  disabled?: boolean;
}

interface TabBarProps {
  value: string;
  onChange: (id: string) => void;
  items: TabBarItem[];
  className?: string;
}

function TabBar({ value, onChange, items, className }: TabBarProps) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex items-center gap-1 border-b border-hairline w-full overflow-x-auto",
        className
      )}
    >
      {items.map((item) => {
        const active = value === item.id;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={item.disabled}
            onClick={() => onChange(item.id)}
            className={cn(
              "min-h-11 md:min-h-0 relative inline-flex items-center gap-2 px-3 py-2 text-sm font-medium whitespace-nowrap",
              "transition-colors border-b-2 -mb-px",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2 rounded-t-md",
              active
                ? "text-ink border-amber"
                : "text-ink-3 hover:text-ink border-transparent",
              item.disabled && "opacity-50 cursor-not-allowed"
            )}
          >
            {item.dot && (
              <span
                className={cn(
                  "w-1.5 h-1.5 rounded-full flex-shrink-0",
                  item.dot === "emerald" && "bg-emerald",
                  item.dot === "amber" && "bg-amber",
                  item.dot === "rose" && "bg-rose",
                  item.dot === "indigo" && "bg-indigo",
                  item.dot === "slate" && "bg-slate"
                )}
              />
            )}
            <span>{item.label}</span>
            {item.count !== undefined && (
              <span
                className={cn(
                  "ml-0.5 text-xs px-1.5 py-0.5 rounded-full tabular-nums",
                  active ? "bg-amber-soft text-amber-ink" : "bg-paper-2 text-ink-3"
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, TabBar };
