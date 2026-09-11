"use client";

/**
 * The customer portal's left sidebar — the staff `Sidebar`'s shape, reduced.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * Pardeep, 11 Sep 2026: "i want my customer portal UI to consistent with old
 * panel." The portal had already been brought onto the app's primitives, type,
 * tokens, header shape and titled-card sections — and it still read as a
 * different product, because the one remaining difference was the one that
 * decides a screen's shape: the staff app is a 240px rail plus content, and
 * this was a centred column under a horizontal bar.
 *
 * ─── WHAT IS COPIED, AND WHAT IS NOT ────────────────────────────────────────
 * Copied from `components/layout/Sidebar.tsx` so the two feel like one product:
 * the 240px width, the sticky full-height rail with a right hairline, the brand
 * block with its 36px mark, grouped items under small uppercase headings, the
 * `bg-amber-soft text-amber-ink` active pill, and the icon treatment.
 *
 * NOT copied, because a customer has no use for them and the brief was
 * explicitly "sections can be reduced, authority can be reduced":
 *   · collapse-to-rail — ten items never need collapsing, and the staff toggle
 *     exists because that sidebar has ten GROUPS
 *   · role filtering — there is one kind of portal user
 *   · expandable sub-trees — nothing here is two levels deep
 *
 * ─── MOBILE IS UNCHANGED ON PURPOSE ─────────────────────────────────────────
 * This is `hidden md:flex`, exactly as the staff sidebar is. The phone keeps the
 * horizontal scrolling strip in `portal-nav.tsx`, which was built with measured
 * scroll behaviour (it scrolls the active item into view) and is already tested.
 * Replacing it with a hamburger sheet would trade a working, one-tap nav for one
 * that needs two taps, to match a surface a customer rarely uses on a phone.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn, initials } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";

/**
 * Ten flat links became four groups.
 *
 * The staff sidebar groups because it has to — forty-odd destinations. Ten does
 * not require it, but the same headings are what make the two rails read as one
 * design, and the grouping is honest: it is the order a customer meets these
 * things in. What you own, what you owe, then who to ask.
 */
const GROUPS: Array<{
  section: string;
  icon: string;
  items: Array<{ href: string; label: string; icon: string }>;
}> = [
  {
    section: "Home",
    icon: "home",
    items: [{ href: "/portal/dashboard", label: "Dashboard", icon: "home" }],
  },
  {
    section: "Your services",
    icon: "layers",
    items: [
      { href: "/portal/domains", label: "Domains", icon: "globe" },
      { href: "/portal/hosting", label: "Hosting", icon: "package" },
      { href: "/portal/subscription", label: "Subscription", icon: "layers" },
      { href: "/portal/shop", label: "Shop", icon: "cart" },
    ],
  },
  {
    section: "Money",
    icon: "rupee",
    items: [
      { href: "/portal/orders", label: "Orders", icon: "inbox" },
      { href: "/portal/invoices", label: "Invoices", icon: "receipt" },
      { href: "/portal/billing", label: "Billing", icon: "rupee" },
    ],
  },
  {
    section: "Account",
    icon: "user",
    items: [
      { href: "/portal/support", label: "Support", icon: "ticket" },
      { href: "/portal/profile", label: "Profile", icon: "user" },
    ],
  },
];

export function PortalSidebar({
  brandName,
  gstin,
}: {
  brandName: string;
  gstin?: string | null;
}) {
  const pathname = usePathname();

  /* `startsWith` for the section, exact for the rest: /portal/support/new must
     light "Support" up, and nothing else should light up on a nested route. */
  const isActive = (href: string) =>
    href === "/portal/dashboard" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  /* Single-open, like the staff rail: a group the reader opened wins, otherwise
     the one holding the current page is open. `""` means "all shut". */
  const [manualOpen, setManualOpen] = React.useState<string | null>(null);
  React.useEffect(() => setManualOpen(null), [pathname]);

  const renderLink = (item: { href: string; label: string; icon: string }) => {
    const active = isActive(item.href);
    return (
      <Link
        key={item.href}
        href={item.href as never}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group flex items-center gap-2.5 px-3 rounded-md text-sm transition-colors min-h-[44px]",
          active ? "bg-amber-soft text-amber-ink font-medium" : "text-ink-2 hover:bg-paper-2 hover:text-ink",
        )}
      >
        <Icon
          name={item.icon}
          size={15}
          className={cn("flex-shrink-0", active ? "text-amber" : "text-ink-3 group-hover:text-ink-2")}
        />
        <span className="flex-1 truncate">{item.label}</span>
      </Link>
    );
  };

  return (
    <aside className="hidden md:flex flex-col border-r border-hairline bg-paper sticky top-0 h-screen w-60 flex-shrink-0">
      {/* Brand — the same block as the staff rail, with the reseller's mark. */}
      <div className="flex items-center gap-2.5 border-b border-hairline flex-shrink-0 px-4 py-4">
        <div className="w-9 h-9 rounded-md bg-ink text-paper grid place-items-center font-serif text-lg flex-shrink-0">
          {initials(brandName)}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-tight truncate" title={brandName}>
            {brandName}
          </div>
          <div className="text-2xs text-ink-3">Customer Portal</div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5" aria-label="Portal sections">
        {/* ─── THE STAFF RAIL'S GROUP ROW, NOT AN UPPERCASE LABEL ─────────────
            Corrected 11 Sep 2026, comparing the two rails side by side. I had
            written small uppercase headings and described them in the commit as
            "the same headings" — they are not. `Sidebar.tsx:240` renders a group
            as a BUTTON: section icon, label, and a chevron, with the children
            indented under a left hairline. That is the vocabulary; uppercase
            text was my invention sitting next to it.

            A single-item group renders as a plain link, which is what the staff
            rail does too (`Sidebar.tsx:232`) — a chevron that expands one item
            is a control that does nothing. */}
        {GROUPS.map((group) => {
          const groupActive = group.items.some((i) => isActive(i.href));

          if (group.items.length === 1) return <div key={group.section}>{renderLink(group.items[0])}</div>;

          const open = manualOpen !== null ? group.section === manualOpen : groupActive;
          return (
            <div key={group.section}>
              <button
                type="button"
                onClick={() => setManualOpen(open ? "" : group.section)}
                aria-expanded={open}
                className={cn(
                  "group w-full flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                  groupActive ? "text-ink font-medium" : "text-ink-2 hover:bg-paper-2 hover:text-ink",
                )}
              >
                <Icon
                  name={group.icon}
                  size={17}
                  className={cn("flex-shrink-0", groupActive ? "text-amber" : "text-ink-3 group-hover:text-ink-2")}
                />
                <span className="flex-1 text-left">{group.section}</span>
                <Icon
                  name={open ? "chevron_down" : "chevron_right"}
                  size={14}
                  className="text-ink-3/60 group-hover:text-ink-3"
                />
              </button>
              {open && (
                <div className="mt-0.5 mb-1 ml-[19px] pl-2 border-l border-hairline space-y-0.5">
                  {group.items.map(renderLink)}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* The reseller's GSTIN sat in the footer of every page. It belongs here:
          it identifies who the customer is dealing with, which is what the rest
          of this rail is about, and it stops the footer being the only place a
          long scroll ever reaches. */}
      {gstin && (
        <div className="border-t border-hairline px-4 py-3 text-3xs text-ink-3 flex-shrink-0">
          GSTIN <span className="font-mono">{gstin}</span>
        </div>
      )}
    </aside>
  );
}
