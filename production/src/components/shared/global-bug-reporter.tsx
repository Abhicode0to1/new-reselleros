"use client";

import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { FeedbackDialog } from "@/components/shared/feedback-dialog";

export function GlobalBugReporter() {
  const [open, setOpen] = React.useState(false);

  // Global Keyboard Shortcut: Ctrl + Shift + B or Cmd + Shift + B
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <>
      {/* Floating Action Button — Always on top (z-[9999]) */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-[9999] bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs px-3.5 py-2.5 rounded-full shadow-2xl hover:scale-105 transition-all flex items-center gap-2 border-2 border-white focus:outline-none focus:ring-2 focus:ring-rose-400 group"
        title="Report Bug / Feedback (Ctrl + Shift + B)"
      >
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-white"></span>
        </span>
        <Icon name="bug" size={16} className="group-hover:rotate-12 transition-transform" />
        <span className="tracking-wide">Report Bug</span>
        <span className="hidden sm:inline-block text-[10px] bg-rose-800/80 px-1.5 py-0.5 rounded text-white font-mono">
          Ctrl+Shift+B
        </span>
      </button>

      {/* Global Feedback Dialog (z-[99999]) */}
      <FeedbackDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
