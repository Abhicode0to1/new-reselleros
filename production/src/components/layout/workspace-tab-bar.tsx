/**
 * Workspace tab strip.
 *
 * Presentation only — every decision lives in the provider and the two tested
 * state machines behind it.
 *
 * ─── IT RENDERS NOTHING UNTIL THERE ARE TWO TABS ─────────────────────────────
 * A tab strip showing one tab is pure decoration: it takes vertical space on every
 * screen, on a product whose users work on laptops and phones, and tells the
 * reader nothing they cannot already see from the page they are on. It appears
 * when it starts being useful.
 */
"use client";

import * as React from "react";
import { useWorkspaceTabs, MAX_TABS } from "@/components/providers/workspace-tabs-provider";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export function WorkspaceTabBar() {
  const { tabs, activeId, activate, close, isNavigating } = useWorkspaceTabs();

  if (tabs.length < 2) return null;

  return (
    <div
      role="tablist"
      aria-label="Open workspace tabs"
      className="relative flex items-stretch gap-1 px-2 h-9 bg-paper-2/60 border-b border-hairline overflow-x-auto shrink-0"
    >
      {/* A route can take seconds to arrive — badly so in dev, where it is
          compiled on first visit. Without this the highlight jumps instantly,
          the page does not, and a working tab strip reads as broken; that is
          exactly what happened during testing. A 1px bar is enough to say
          "still working" without becoming a spinner nobody asked for. */}
      {isNavigating && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-amber/70 animate-pulse"
        />
      )}
      {tabs.map((t, i) => {
        const isActive = t.id === activeId;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            // The whole tab is clickable, but the close control inside it is a
            // real <button>. A nested button inside a button is invalid HTML and
            // breaks keyboard focus, so this stays a div with an explicit role.
            onClick={() => activate(t.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(t.id); }
            }}
            // Middle-click closes, the way every tab strip people already use does.
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); close(t.id); } }}
            title={`${t.title}${t.isDraft ? " — unsaved changes" : ""}\nAlt+${i + 1}`}
            className={cn(
              "group flex items-center gap-1.5 pl-2.5 pr-1.5 rounded-t-md text-xs whitespace-nowrap cursor-pointer transition-colors max-w-[15rem]",
              isActive
                ? "bg-paper text-ink border border-b-0 border-hairline font-medium"
                : "text-ink-2 hover:bg-paper/60 border border-transparent",
            )}
          >
            {t.icon && <Icon name={t.icon as never} size={13} className="shrink-0 text-ink-3" />}
            <span className="truncate">{t.title}</span>

            {/* The draft marker is a dot AND a screen-reader word. An asterisk
                alone communicates nothing to anyone not looking at it. */}
            {t.isDraft && (
              <>
                <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-amber shrink-0" />
                <span className="sr-only">unsaved changes</span>
              </>
            )}

            <button
              type="button"
              aria-label={`Close ${t.title}`}
              onClick={(e) => { e.stopPropagation(); close(t.id); }}
              className={cn(
                "shrink-0 rounded p-0.5 text-ink-3 hover:bg-paper-2 hover:text-ink",
                // Always visible on the active tab; revealed on hover elsewhere so
                // the strip stays quiet. Kept focusable either way, or it would be
                // unreachable by keyboard.
                isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100",
              )}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        );
      })}

      {tabs.length >= MAX_TABS && (
        <span className="self-center pl-2 text-[10px] text-ink-3 whitespace-nowrap">
          {MAX_TABS} max
        </span>
      )}
    </div>
  );
}
