/**
 * (app) layout — authenticated app shell with Sidebar + TopBar.
 * Wraps all internal app routes: /dashboard, /leads, /customers, etc.
 *
 * Mobile: sidebar collapses behind hamburger.
 * Desktop: 240px sidebar + main content.
 */
"use client";

import * as React from "react";
import { Sidebar, MobileSidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/topbar";
import { MobileBottomNav } from "@/components/layout/MobileBottomNav";
import { WorkspaceTabBar } from "@/components/layout/workspace-tab-bar";
import { GlobalBugReporter } from "@/components/shared/global-bug-reporter";
import { AttendanceReminder } from "@/components/features/attendance/attendance-reminder";
import { SentryBoot } from "@/components/shared/sentry-boot";
import { ShortcutsSheet } from "@/components/shared/shortcuts-sheet";
import { useGlobalKeys } from "@/lib/hooks/useKeyboard";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);

  /* ─── THE GLOBAL KEYS LIVE HERE, ONCE ──────────────────────────────────────
     `g l` and `?` are mounted in the shell rather than per page. Mounting them per page
     would stack a listener for every route the operator has visited and fire one keypress
     several times — a double navigation that looks like the app skipping a screen.

     Both refuse to fire while a field has focus; that rule and the `g` timing live in
     lib/keyboard/shortcuts.ts with tests, because a shortcut that eats a keystroke out of
     somebody's typing is the way this feature fails. */
  const [helpOpen, setHelpOpen] = React.useState(false);
  useGlobalKeys(() => setHelpOpen(true));

  return (
    <div className="flex min-h-screen bg-paper-2/50">
      {/* Desktop sidebar (sticky 240px) */}
      <Sidebar />

      {/* Mobile sidebar (slide-in drawer — opened from TopBar hamburger AND MobileBottomNav "More") */}
      <MobileSidebar open={mobileNavOpen} onOpenChange={setMobileNavOpen} />

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar onMobileMenuClick={() => setMobileNavOpen(true)} />
        {/* Renders nothing until a second tab is open — a one-tab strip is
            decoration that costs vertical space on every screen. */}
        <WorkspaceTabBar />
        {/* pb-16 on mobile so content doesn't hide behind the bottom tab bar */}
        <main className="flex-1 min-w-0 pb-16 md:pb-0">{children}</main>
      </div>

      {/* Sticky mobile bottom tab bar (phone only) */}
      <MobileBottomNav onMoreClick={() => setMobileNavOpen(true)} />

      {/* Always-on-top Global Floating Bug Reporter (z-[9999]) */}
      <GlobalBugReporter />

      {/* Check-in / check-out nudge. Here rather than on /attendance/me, because the
          people who miss a punch are precisely the ones not looking at that page. It
          renders nothing unless a punch is actually outstanding, and never on
          /attendance itself. */}
      {/* Browser-side Sentry init. Inert until NEXT_PUBLIC_SENTRY_DSN is set — and until
          it is, every React render error the operator sees goes nowhere, because the two
          error boundaries call captureException on a client that was never initialised. */}
      <SentryBoot />
      <AttendanceReminder />

      {/* The ? cheat sheet. Rendered from the same registry the handlers read, so it cannot
          list a shortcut nobody implemented — or omit one that works. */}
      <ShortcutsSheet open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}
