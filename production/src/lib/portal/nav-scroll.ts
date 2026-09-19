/**
 * Where the portal's narrow nav strip has to be scrolled so the section you are
 * actually in is on screen.
 *
 * ─── THE BUG THIS EXISTS FOR, MEASURED ──────────────────────────────────────
 * The portal nav has ten sections. On 9 Sep 2026 the design gate found that
 * nothing said which one you were in, and `aria-current="page"` plus an amber
 * label was added. Measured on a 390px phone on 11 Sep, on `/portal/profile`:
 *
 *     scrollWidth   774      clientWidth   390      scrollLeft   0
 *     fully visible Dashboard, Subscription, Domains, Hosting
 *     hidden        Shop, Orders, Billing, Invoices, Support, Profile
 *     activeVisible false
 *
 * The strip is twice as wide as the phone and never moves, so for six of the ten
 * sections the "you are here" marker sits off-screen. The 9 Sep fix works for a
 * screen reader — the attribute is in the DOM either way — and is invisible to
 * the eye exactly when the customer is in one of those six. A customer on
 * Billing saw a nav that opened on Dashboard with nothing highlighted, which
 * reads as "no section is current", i.e. the state the fix was meant to end.
 *
 * ─── WHY THE MATHS IS HERE AND NOT IN THE COMPONENT ─────────────────────────
 * Because it is the part that can be wrong in a way nobody sees. Both ends are
 * off-by-one traps: centring Dashboard wants a NEGATIVE scrollLeft, and centring
 * Profile wants one PAST the end. Browsers silently clamp both, so a missing
 * clamp would look correct in a browser and then behave differently the moment
 * the strip is scrolled by hand first — the failure would show up as "the nav
 * sometimes jumps". jsdom has no layout, so a component test could not measure
 * any of this; a pure function can, and does, below.
 */

export interface StripGeometry {
  /**
   * The link's left edge in the strip's own SCROLLED coordinate space — i.e.
   * distance from the start of the scrollable content, not from the viewport.
   * The caller converts:
   *   linkLeft = link.rect.left - strip.rect.left + strip.scrollLeft
   */
  linkLeft: number;
  linkWidth: number;
  /** The strip's visible width (`clientWidth`). */
  viewportWidth: number;
  /** The strip's full scrollable width (`scrollWidth`). */
  scrollWidth: number;
}

/**
 * The `scrollLeft` that puts `link` as close to the middle of the strip as the
 * ends allow. Always within `[0, scrollWidth - viewportWidth]`.
 *
 * Centred rather than merely "just in view" on purpose: a link scrolled to sit
 * flush against the right edge looks like the last one, which is the same
 * misreading the whole strip suffers from. Centring shows the sections on BOTH
 * sides, so the strip reads as a strip.
 */
export function centredScrollLeft(g: StripGeometry): number {
  /* Never negative: a strip narrower than its viewport has nowhere to go, and
     `scrollWidth < viewportWidth` can happen mid-resize. */
  const maxScroll = Math.max(0, g.scrollWidth - g.viewportWidth);
  const ideal = g.linkLeft - (g.viewportWidth - g.linkWidth) / 2;
  return Math.max(0, Math.min(ideal, maxScroll));
}

/**
 * Which edges of the strip have more content beyond them.
 *
 * ─── WHY THIS IS NEEDED AS WELL ─────────────────────────────────────────────
 * Scrolling the current section into view fixes the marker, and leaves the
 * second half of the problem: on `/portal/dashboard` the strip sits at 0 and six
 * sections are simply not there. In the 390px screenshot the only hint was the
 * word "Shop" happening to be clipped mid-letter — which is luck. Had a label
 * ended flush with the viewport edge, the strip would have looked complete and
 * Billing, Invoices, Support and Profile would have been undiscoverable.
 *
 * So the edges are drawn, and only when there is really something past them —
 * a permanent fade would claim there is more to see at the end of the strip.
 *
 * The 1px tolerance is not decoration: `scrollLeft` is fractional on a device
 * with a non-integer pixel ratio, so `scrollLeft + clientWidth === scrollWidth`
 * is false at the true end by a fraction, and without it the right-hand fade
 * would never switch off.
 */
export function scrollEdges(o: {
  scrollLeft: number;
  viewportWidth: number;
  scrollWidth: number;
}): { left: boolean; right: boolean } {
  return {
    left: o.scrollLeft > 1,
    right: o.scrollLeft + o.viewportWidth < o.scrollWidth - 1,
  };
}
