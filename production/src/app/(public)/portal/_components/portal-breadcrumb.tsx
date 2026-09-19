"use client";

/**
 * The portal's breadcrumb — the staff TopBar's, in the same place and shape.
 *
 * ─── WHY IT EXISTS ──────────────────────────────────────────────────────────
 * Added 11 Sep 2026. Once the rail took over the brand and the navigation, the
 * portal header had nothing in it and the account chip sat at the LEFT edge of
 * an empty bar — which reads as a broken row rather than a quiet one.
 * `topbar.tsx:92` is the original: breadcrumb left, `flex-1` spacer, everything
 * else right.
 *
 * ─── IT NAMES THE SECTION, NOT THE URL ──────────────────────────────────────
 * Derived from the path, but through a label map rather than by title-casing
 * segments. `/portal/support/new` title-cased gives "Support › New", and
 * "New" is not a thing a customer recognises; the map says "Raise a ticket".
 * An id segment (a uuid, a number) is dropped rather than printed, because a
 * breadcrumb showing `a3f2…` tells the reader nothing and costs a line.
 *
 * Hidden on phones, exactly as the staff one is: at 390px the row belongs to
 * the brand and the account menu, and a third element makes all three cramped.
 */

import * as React from "react";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/icon";

/** Segment → what a customer calls it. */
const LABELS: Record<string, string> = {
  portal: "Home",
  dashboard: "Dashboard",
  domains: "Domains",
  hosting: "Hosting",
  subscription: "Subscription",
  shop: "Shop",
  orders: "Orders",
  invoices: "Invoices",
  billing: "Billing",
  support: "Support",
  profile: "Profile",
  new: "Raise a ticket",
};

/** A uuid or a bare number is an id, not a place. */
const IS_ID = /^[0-9a-f]{8}-[0-9a-f-]{20,}$|^\d+$/i;

export function PortalBreadcrumb() {
  const pathname = usePathname();

  const crumbs = pathname
    .split("/")
    .filter(Boolean)
    .filter((seg) => !IS_ID.test(seg))
    .map((seg) => LABELS[seg] ?? seg.replace(/-/g, " "));

  /* `/portal/dashboard` is "Home › Dashboard", which matches the staff app
     reading "Home › Dashboard" for its own landing page. */
  if (crumbs.length === 0) return null;

  return (
    <nav
      aria-label="Breadcrumb"
      className="hidden md:flex items-center gap-1.5 text-xs text-ink-3 overflow-hidden"
    >
      {crumbs.map((c, i) => (
        <React.Fragment key={`${c}-${i}`}>
          {i > 0 && <Icon name="chevron_right" size={12} className="text-ink-4 flex-shrink-0" />}
          <span className={i === crumbs.length - 1 ? "font-semibold text-ink truncate" : "truncate"}>
            {c}
          </span>
        </React.Fragment>
      ))}
    </nav>
  );
}
