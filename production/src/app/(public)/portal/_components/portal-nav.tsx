"use client";

/**
 * Portal section nav — both the inline desktop row and the narrow scrollable strip.
 *
 * ─── WHY THIS IS A CLIENT ISLAND ─────────────────────────────────────────────
 * It needs the current path to say which section you are in, and `usePathname` is
 * client-only. The portal layout is a Server Component (it reads the session), so the
 * nav moved out here rather than dragging the whole layout across the boundary. Same
 * shape as `components/layout/Sidebar.tsx` and `MobileBottomNav.tsx`, which resolve
 * their active state the same way.
 *
 * ─── TWO THINGS THE DESIGN GATE FOUND HERE (9 Sep 2026) ──────────────────────
 * Both were pre-existing, and both were made harder to live with by growing the nav
 * from 8 items to 10 on 8 Sep.
 *
 * 1. NOTHING SAID WHICH SECTION YOU WERE IN. Measured: all 10 links resolved to one
 *    computed style — rgb(112,105,97) at weight 400 — and there was no `aria-current`
 *    anywhere in the portal. So the current page was indistinguishable both to the eye
 *    and to a screen reader, on a nav that had just got longer. `aria-current="page"`
 *    is the attribute for a current item that is not a toggle; `aria-pressed` would be
 *    wrong here, because these are links and not buttons.
 *
 * 2. THE TAP TARGETS WERE 20px TALL. CLAUDE.md:605 (§20, CRITICAL) requires ≥44px, and
 *    `portal/domains/page.tsx` calls the portal "a phone-first surface". The strip's
 *    `py-2.5` sat on the CONTAINER, so it padded the row and not the link — the row was
 *    40px and every link inside it 20px. Padding a parent does not grow a child's hit
 *    area. The floor now sits on the <Link> itself, which is what `MobileBottomNav`
 *    already does (`min-h-[56px]`, there because it stacks an icon over a label).
 *
 * The floor is applied to the STRIP and not to the inline desktop row, following the
 * same split the app already makes: `MobileBottomNav` carries a touch floor and the
 * desktop `Sidebar` does not. The strip is the surface a thumb uses.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { centredScrollLeft, scrollEdges } from "@/lib/portal/nav-scroll";

/* Assets before commerce. Domains and Hosting are the things the customer OWNS and the
   things that can lapse; Shop and Orders are what they did. Someone opening the portal
   because a site went down or a renewal notice arrived is looking for these two, and
   burying them under Orders would put the urgent thing behind the historical one. Added
   8 Sep 2026 with the `domains` / `hosting_accounts` tables — before those, neither page
   could show anything, which is why the portal had no such section. */
const NAV: Array<{ href: string; label: string }> = [
  { href: "/portal/dashboard",    label: "Dashboard" },
  { href: "/portal/subscription", label: "Subscription" },
  { href: "/portal/domains",      label: "Domains" },
  { href: "/portal/hosting",      label: "Hosting" },
  { href: "/portal/shop",         label: "Shop" },
  { href: "/portal/orders",       label: "Orders" },
  /* Billing and Invoices are both here on purpose — Billing is the payment method and
     the plan, Invoices is the document history. An earlier version of this nav had no
     Billing in it. */
  { href: "/portal/billing",      label: "Billing" },
  { href: "/portal/invoices",     label: "Invoices" },
  { href: "/portal/support",      label: "Support" },
  { href: "/portal/profile",      label: "Profile" },
];

/** Exact match, not startsWith: every portal section is a leaf, so a prefix match would
 *  light up two rows the moment one href becomes a prefix of another. */
function useActive() {
  const pathname = usePathname();
  return (href: string) => pathname === href;
}

/**
 * The inline row. Shown only at 1080px — the header's own max-width — so it appears
 * exactly when there is room for it; see the layout for that measurement.
 *
 * gap-4 rather than gap-5 is also load-bearing: the header row is capped at
 * max-w-[1080px] with px-6, so everything competes for 1032px, and at gap-5 the nav
 * group took 794 of it and left the brand 238 where it needs 252 — which truncated the
 * reseller's business name to "Excel Technologies Pv...". Nine gaps at 4px less each
 * returns 36px. If a future nav item eats that room, widen the budget or shorten labels;
 * do not let the brand absorb it, because it carries min-w-0 and will give way silently.
 */
export function PortalNavInline() {
  const isActive = useActive();
  return (
    <nav
      aria-label="Portal sections"
      className="hidden min-[1080px]:flex items-center gap-0.5 text-sm text-ink-3"
    >
      {/* ─── THE STAFF SIDEBAR'S ACTIVE STATE, NOT A SECOND ONE ──────────────
          Changed 11 Sep 2026 — Pardeep: "Including navbar design". The app had
          two vocabularies for the same idea (design-critique §4): the staff
          Sidebar marks the current section with a filled pill,
          `bg-amber-soft text-amber-ink font-medium`, and this used colour and
          weight alone. Colour-only is legible but it is a DIFFERENT language,
          and a customer who has seen the staff app should not have to learn a
          second one to find where they are.

          `gap-1` with padding inside each item, rather than `gap-4` with none —
          a pill needs its own box, and spacing between boxes reads as spacing
          between pills. It also gives every item a 44px hit area (§20), which
          bare text links did not have. */}
      {NAV.map((n) => {
        const active = isActive(n.href);
        return (
          <Link
            key={n.href}
            href={n.href as never}
            aria-current={active ? "page" : undefined}
            className={cn(
              "whitespace-nowrap transition-colors rounded-md px-2 min-h-[44px] inline-flex items-center",
              active ? "bg-amber-soft text-amber-ink font-medium" : "hover:bg-paper-2 hover:text-ink",
            )}
          >
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The narrow strip — phone AND tablet, up to 1080px. It scrolls INSIDE itself
 * (overflow-x-auto + min-w-max), which is why it never pushed the page sideways the way
 * the inline row did before 9 Sep.
 *
 * ─── WHAT 9 SEP MISSED, MEASURED 11 SEP ──────────────────────────────────────
 * `aria-current` fixed "nothing says which section you are in" for a screen reader and
 * NOT for the eye. At 390px the strip is 774px wide and it never moved, so:
 *
 *     fully visible   Dashboard, Subscription, Domains, Hosting
 *     off-screen      Shop, Orders, Billing, Invoices, Support, Profile
 *
 * A customer on `/portal/billing` therefore saw a nav opening on Dashboard with nothing
 * highlighted anywhere in it — which reads as "no section is current", the exact state
 * the amber label was added to end. Six of ten sections. Two things were needed:
 *
 *   1. SCROLL THE CURRENT SECTION INTO VIEW. `scrollLeft` is set directly rather than
 *      calling `scrollIntoView`, because that walks up to every scrollable ancestor —
 *      it would have jumped the whole PAGE to bring a nav link into view, which on a
 *      phone means the customer lands below the heading they navigated for.
 *
 *   2. SAY THAT THE STRIP SCROLLS AT ALL. Even scrolled correctly, a customer on
 *      Dashboard has no way to know Billing exists. The only hint in the 390px
 *      screenshot was "Shop" happening to be clipped mid-word, which is luck — a label
 *      ending flush with the edge would have made the strip look complete. So the
 *      overflowing edges are faded, and only while something is really past them.
 *
 * The maths for both lives in `lib/portal/nav-scroll.ts`, tested against this strip's
 * real measured geometry, because jsdom has no layout and could not check any of it.
 */
export function PortalNavStrip() {
  const isActive = useActive();
  const pathname = usePathname();
  const stripRef = React.useRef<HTMLElement | null>(null);
  const [edges, setEdges] = React.useState({ left: false, right: false });

  /* Declared BEFORE the edge effect on purpose: effects run in order, so the edge read
     below sees the position this one just set rather than the stale 0. */
  React.useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const link = strip.querySelector<HTMLElement>('[aria-current="page"]');
    if (!link) return;
    const linkRect = link.getBoundingClientRect();
    strip.scrollLeft = centredScrollLeft({
      /* Into the strip's own scrolled space — see nav-scroll.ts. Via rects and not
         `offsetLeft`, which is relative to whichever ancestor happens to be positioned
         and would silently change meaning if a wrapper gained `relative`. */
      linkLeft: linkRect.left - strip.getBoundingClientRect().left + strip.scrollLeft,
      linkWidth: linkRect.width,
      viewportWidth: strip.clientWidth,
      scrollWidth: strip.scrollWidth,
    });
  }, [pathname]);

  React.useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const read = () =>
      setEdges(
        scrollEdges({
          scrollLeft: strip.scrollLeft,
          viewportWidth: strip.clientWidth,
          scrollWidth: strip.scrollWidth,
        }),
      );
    read();
    strip.addEventListener("scroll", read, { passive: true });
    /* Rotating the phone changes which edges overflow, and there is no scroll event for
       that. Guarded because this file is imported by tests in environments without it. */
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(read) : null;
    ro?.observe(strip);
    return () => {
      strip.removeEventListener("scroll", read);
      ro?.disconnect();
    };
  }, [pathname]);

  return (
    /* The fades are siblings of the scroller, not children of it — a child of an
       overflow container scrolls away with the content, so an inner fade would slide
       off the moment it was needed. `relative` therefore lives out here. */
    /* ─── `md:hidden`, NOT `min-[1080px]:hidden` ─────────────────────────────
       The 1080 threshold paired this strip with `PortalNavInline`, which showed
       at exactly the header's max-width. The rail replaced that row on 11 Sep
       2026 and appears at `md` — so the old threshold left a window where BOTH
       navigations were on screen. Measured: at 820px and 1024px two navs
       visible (a 791px rail and a 44px strip); only at 1100px did it come right.
       It now hides exactly where the rail appears. */
    <div className="relative md:hidden border-t border-hairline">
      <nav ref={stripRef} className="overflow-x-auto" aria-label="Portal sections">
        {/* No vertical padding here on purpose — it belongs on the links, or it pads the
            row while leaving each tap target 20px tall. */}
        <div className="flex items-center gap-5 px-6 text-sm text-ink-3 whitespace-nowrap min-w-max">
          {NAV.map((n) => {
            const active = isActive(n.href);
            return (
              <Link
                key={n.href}
                href={n.href as never}
                aria-current={active ? "page" : undefined}
                /* Same pill as the desktop row above and as the staff Sidebar,
                   so the current section looks the same on every surface. */
                className={cn(
                  // touch-target floor (§20 / CLAUDE.md:605) — on the LINK, not the row
                  "inline-flex items-center min-h-[44px] transition-colors",
                  active ? "bg-amber-soft text-amber-ink font-medium rounded-md" : "hover:text-ink",
                )}
              >
                {n.label}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* `from-paper` matches the header this sits in — see portal/layout.tsx. Decoration
          only: aria-hidden so it is not announced, pointer-events-none so it cannot eat
          a tap meant for the link underneath it. */}
      {edges.left && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-paper to-transparent"
        />
      )}
      {edges.right && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-paper to-transparent"
        />
      )}
    </div>
  );
}
