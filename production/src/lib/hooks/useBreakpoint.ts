/**
 * useBreakpoint — SSR-safe responsive breakpoint hook.
 *
 * Mirrors the Tailwind breakpoint config so JS can branch on the same
 * cutoffs the CSS uses. Critical for rendering ALTERNATE components per
 * device (e.g., <table> on desktop, <CardList> on mobile) where CSS
 * `hidden md:block` would still ship both DOM trees and inflate the
 * mobile payload + slow hydration.
 *
 * Breakpoints (must match tailwind.config.ts defaults):
 *   sm:  640px
 *   md:  768px    ← "tablet" floor
 *   lg:  1024px   ← "desktop" floor
 *   xl:  1280px
 *
 * SSR strategy:
 *   - On the server, no `window` exists → returns the conservative
 *     "desktop" guess so the initial HTML matches what a desktop visitor
 *     sees (most reseller laptops). React hydrates, the matchMedia query
 *     fires, and the client snaps to the true breakpoint.
 *   - To avoid layout flash on mobile, components that critically depend
 *     on this hook should accept a `loading` fallback that's safe for
 *     either device class. Or render nothing until `mounted` is true, if the difference
 *     is too jarring.
 *
 * @example
 *   const { isMobile, isTablet, isDesktop } = useBreakpoint();
 *   if (isMobile) return <CardList items={quotes} />;
 *   return <QuotesTable rows={quotes} />;
 */
"use client";

import * as React from "react";

export interface Breakpoint {
  /** < 768px — phones. */
  isMobile:  boolean;
  /** 768–1023px — tablets, small laptops. */
  isTablet:  boolean;
  /** ≥ 1024px — laptops, desktops. Default for SSR. */
  isDesktop: boolean;
  /** Current width in px (0 during SSR). */
  width:     number;
}

const QUERIES = {
  mobile: "(max-width: 767px)",
  tablet: "(min-width: 768px) and (max-width: 1023px)",
} as const;

export function useBreakpoint(): Breakpoint {
  // SSR-safe defaults — desktop assumption.
  const [bp, setBp] = React.useState<Breakpoint>({
    isMobile:  false,
    isTablet:  false,
    isDesktop: true,
    width:     0,
  });

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    const update = () => {
      const w = window.innerWidth;
      const isMobile = window.matchMedia(QUERIES.mobile).matches;
      const isTablet = window.matchMedia(QUERIES.tablet).matches;
      setBp({
        isMobile,
        isTablet,
        isDesktop: !isMobile && !isTablet,
        width:     w,
      });
    };

    update();

    // Listen for size changes (orientation flip, window resize).
    const mqMobile = window.matchMedia(QUERIES.mobile);
    const mqTablet = window.matchMedia(QUERIES.tablet);
    mqMobile.addEventListener("change", update);
    mqTablet.addEventListener("change", update);
    window.addEventListener("resize", update);

    return () => {
      mqMobile.removeEventListener("change", update);
      mqTablet.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return bp;
}
