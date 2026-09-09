"use client";

/**
 * PortalAccountMenu — the logged-in customer's avatar + dropdown in the portal
 * header. Gives a clear, always-available Sign out (was missing — a customer on
 * a shared device had no way to log out) plus a jump to Profile.
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
}: {
  customerName: string;
  email: string;
}) {
  async function signOut() {
    const { createClient } = await import("@/lib/supabase/client");
    await createClient().auth.signOut();
    window.location.href = "/portal/login";
  }

  return (
    <DropdownMenu>
      {/* min-h/min-w-[44px]: the trigger measured 49x28 on 9 Sep, under the ≥44px floor
          CLAUDE.md:605 (§20) sets. The avatar stays 28px — the hit area grows around it,
          which is why this is min-h and not h. */}
      <DropdownMenuTrigger className="flex items-center justify-center gap-2 min-h-[44px] min-w-[44px] rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2">
        <Avatar initials={initials(customerName) || "?"} color="amber" size="sm" />
        <Icon name="chevron_down" size={13} className="text-ink-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
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
