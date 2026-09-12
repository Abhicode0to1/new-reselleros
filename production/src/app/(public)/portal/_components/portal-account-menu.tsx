"use client";

/**
 * PortalAccountMenu — the logged-in customer's identity + dropdown. Gives a
 * clear, always-available Sign out (was missing — a customer on a shared device
 * had no way to log out) plus a jump to Profile.
 *
 * Two shapes: `rail` at the foot of the sidebar on desktop, matching the staff
 * user chip, and `compact` in the header on a phone where there is no rail.
 */
import * as React from "react";
import { Avatar } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { initials } from "@/lib/utils";

export function PortalAccountMenu({
  customerName,
  email,
  variant = "compact",
}: {
  customerName: string;
  email: string;
  /** `rail` is the staff sidebar's user chip; `compact` the phone header one. */
  variant?: "rail" | "compact";
}) {
  async function signOut() {
    const { createClient } = await import("@/lib/supabase/client");
    await createClient().auth.signOut();
    /* ─── WHERE A SIGNED-OUT CUSTOMER LANDS ───────────────────────────────────
       `/portal/login` in production, and that is not negotiable: `/login` is the
       STAFF door and asks for a password, which a portal customer does not have
       and cannot be given. Sending a real customer there strands them on a form
       they can never complete — the §24 dead end, on the way out.

       In DEVELOPMENT it goes to `/login` instead. Pardeep, 11 Sep 2026: "when
       logging out? why go there? not at login screen directly" — `/login` is
       where the demo accounts box is, so signing out of the portal to test
       something else meant navigating back by hand every time.

       `NODE_ENV` is inlined at build time, so a production bundle contains only
       the `/portal/login` branch. */
    window.location.href = process.env.NODE_ENV === "development" ? "/login" : "/portal/login";
  }

  return (
    <DropdownMenu>
      {/* ─── TWO SHAPES, ONE MENU ────────────────────────────────
          Pardeep, 11 Sep 2026, two screenshots side by side: "orginal app navbar
          compared to our portal navbar / fix the design inconsitenticies".

          The largest of them was this component's ADDRESS, not its styling. The
          staff app ends its rail with the user chip (`Sidebar.tsx:323`) and
          therefore has no account control in the top bar at all; the portal had
          the exact mirror — a chip in the bar and nothing at the foot of the
          rail. Same menu, moved to the same corner.

          `rail`: full width, avatar + name + EMAIL underneath, which is the
          staff chip's shape (the email answers "which account am I in?" without
          opening the dropdown).

          `compact` stays for the PHONE, where `PortalSidebar` is `hidden md:flex`
          and there is no rail to put a chip in.

          min-h/min-w-[44px] on the compact trigger: it measured 49x28 on 9 Sep,
          under the ≥44px floor CLAUDE.md:605 (§20) sets. The avatar stays 28px —
          the hit area grows around it, which is why this is min-h and not h. */}
      {variant === "rail" ? (
        <DropdownMenuTrigger className="w-full flex items-center gap-2.5 p-2 rounded-md hover:bg-paper-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2">
          <Avatar initials={initials(customerName) || "?"} color="amber" size="md" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{customerName}</div>
            <div className="text-2xs text-ink-3 font-mono truncate" title={email}>{email}</div>
          </div>
          <Icon name="chevron_down" size={13} className="text-ink-3 flex-shrink-0" />
        </DropdownMenuTrigger>
      ) : (
        <DropdownMenuTrigger className="flex items-center justify-center gap-2 min-h-[44px] min-w-[44px] rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2">
          <Avatar initials={initials(customerName) || "?"} color="amber" size="sm" />
          <Icon name="chevron_down" size={13} className="text-ink-3" />
        </DropdownMenuTrigger>
      )}
      {/* From the rail the menu opens UPWARD — the trigger is flush with the
          bottom of the viewport, so a downward menu would be clipped. */}
      <DropdownMenuContent
        align={variant === "rail" ? "start" : "end"}
        side={variant === "rail" ? "top" : "bottom"}
        className="w-56"
      >
        <DropdownMenuLabel>
          <div className="truncate font-medium text-ink">{customerName}</div>
          <div className="truncate text-2xs text-ink-3 font-normal">{email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => { window.location.href = "/portal/profile"; }}>
          <Icon name="user" size={14} /> Profile
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => { window.location.href = "/portal/support"; }}>
          <Icon name="ticket" size={14} /> Support
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onClick={signOut}>
          <Icon name="logout" size={14} /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
