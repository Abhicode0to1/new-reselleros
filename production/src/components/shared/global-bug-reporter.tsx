"use client";

import * as React from "react";
import { FeedbackDialog } from "@/components/shared/feedback-dialog";
import { findShortcut, matchesShortcut } from "@/lib/keyboard/shortcuts";

export function GlobalBugReporter() {
  const [open, setOpen] = React.useState(false);

  /* The keys come from the registry, not from this file.
     They used to be spelled out here as `ctrlKey && shiftKey && key === "b"`, and the
     shortcut was in no registry at all — so the cheat sheet did not list it and the
     Report Bug tooltip could not mention it. Reading the entry means the handler, the
     cheat sheet and the tooltip badge cannot disagree about which keys work. */
  React.useEffect(() => {
    const reportBug = findShortcut("report-bug");
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesShortcut(reportBug, e)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return <FeedbackDialog open={open} onOpenChange={setOpen} />;
}
