"use client";

/**
 * The staff TopBar's theme toggle, in the portal's header.
 *
 * ─── WHY THE PORTAL GETS THIS AND NOT THE REST ──────────────────────────────
 * Added 11 Sep 2026 from Pardeep's side-by-side screenshots of the two navbars.
 * The staff bar's right side carries five controls — Report Bug, Search (Ctrl+K),
 * this toggle, Quick actions and the bell — and the portal's carried one, so the
 * two bars read as different products even where every token matched.
 *
 * Four of those five are staff tools, and the brief was "authority can be
 * reduced": a customer has no bug tracker, no quick actions, no notification
 * feed, and a command palette over records they cannot see. The theme toggle is
 * the one that is not authority at all — it is a reader's preference, and the
 * portal already sits under the same `ThemeProvider` (`providers/index.tsx:24`),
 * so the setting a customer picks here is the one the CSS already honours.
 *
 * `mounted` guards hydration exactly as `topbar.tsx:53` does: `resolvedTheme` is
 * undefined on the server, so rendering the real icon before mount produces a
 * sun/moon mismatch React then has to correct in the browser.
 */

import * as React from "react";
import { useTheme } from "next-themes";
import { IconButton } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function PortalThemeToggle() {
  const { setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton
          icon={mounted && resolvedTheme === "dark" ? "sun" : "moon"}
          aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`}
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        />
      </TooltipTrigger>
      <TooltipContent>Toggle theme</TooltipContent>
    </Tooltip>
  );
}
