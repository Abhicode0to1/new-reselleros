/**
 * The nav-strip scroll maths, against the REAL geometry of the real strip.
 *
 * The table below was measured in Chrome at 390x844 on 11 Sep 2026, on
 * `/portal/profile`, by reading each link's own box out of the live strip. It is
 * not invented, and that matters here: both interesting cases in this file are
 * only interesting at the actual widths. Centring the first item wants a
 * negative scrollLeft (-134) and centring the last wants one past the end (532
 * against a maximum of 384) — with made-up round numbers it is easy to write a
 * table where neither end is ever reached and the clamps are never exercised.
 */
import { describe, it, expect } from "vitest";
import { centredScrollLeft, scrollEdges } from "./nav-scroll";

/** Measured: the strip at 390px. Twice the viewport wide. */
const VIEWPORT = 390;
const SCROLL_WIDTH = 774;
const MAX_SCROLL = SCROLL_WIDTH - VIEWPORT; // 384

/** Measured: every link's left edge and width, in the strip's scrolled space. */
const LINKS = [
  { label: "Dashboard", linkLeft: 24, linkWidth: 74 },
  { label: "Subscription", linkLeft: 118, linkWidth: 85 },
  { label: "Domains", linkLeft: 223, linkWidth: 59 },
  { label: "Hosting", linkLeft: 302, linkWidth: 53 },
  { label: "Shop", linkLeft: 374, linkWidth: 36 },
  { label: "Orders", linkLeft: 430, linkWidth: 47 },
  { label: "Billing", linkLeft: 497, linkWidth: 40 },
  { label: "Invoices", linkLeft: 556, linkWidth: 55 },
  { label: "Support", linkLeft: 631, linkWidth: 55 },
  { label: "Profile", linkLeft: 706, linkWidth: 43 },
];

const geometryFor = (l: (typeof LINKS)[number]) => ({
  linkLeft: l.linkLeft,
  linkWidth: l.linkWidth,
  viewportWidth: VIEWPORT,
  scrollWidth: SCROLL_WIDTH,
});

describe("centredScrollLeft — the current section ends up on screen", () => {
  /* The property that is the whole point. Six of these ten were off-screen
     before this function existed; none of them may be off-screen after it. */
  it.each(LINKS)("$label is fully visible once the strip is scrolled", (l) => {
    const scrollLeft = centredScrollLeft(geometryFor(l));
    const left = l.linkLeft - scrollLeft;
    const right = left + l.linkWidth;
    expect(left, `${l.label} starts ${left}px from the strip's left edge`).toBeGreaterThanOrEqual(0);
    expect(right, `${l.label} ends ${right}px in, past the ${VIEWPORT}px edge`).toBeLessThanOrEqual(
      VIEWPORT,
    );
  });

  it.each(LINKS)("$label asks for a scroll the browser can honour", (l) => {
    const scrollLeft = centredScrollLeft(geometryFor(l));
    expect(scrollLeft).toBeGreaterThanOrEqual(0);
    expect(scrollLeft).toBeLessThanOrEqual(MAX_SCROLL);
  });

  /* ─── The two clamps, named ────────────────────────────────────────────────
     Stated as exact values and not just "in range", because the range
     assertions above pass for the WRONG reason if a clamp goes missing: an
     unclamped Dashboard (-134) still leaves the link inside the viewport
     arithmetically, so only the exact value catches it. */
  it("does not ask for a negative scroll to centre the FIRST section", () => {
    const g = geometryFor(LINKS[0]);
    /* Unclamped this is 24 - (390 - 74) / 2 = -134. */
    expect(centredScrollLeft(g)).toBe(0);
  });

  it("does not ask to scroll past the end to centre the LAST section", () => {
    const g = geometryFor(LINKS[LINKS.length - 1]);
    /* Unclamped this is 706 - (390 - 43) / 2 = 532.5, against a 384 maximum. */
    expect(centredScrollLeft(g)).toBe(MAX_SCROLL);
  });

  it("centres a section that has room on both sides", () => {
    /* Billing — the one a customer reaches from an unpaid-invoice email, and one
       of the six that used to be invisible. 497 - (390 - 40) / 2 = 322. */
    const scrollLeft = centredScrollLeft(geometryFor(LINKS[6]));
    expect(scrollLeft).toBe(322);
    /* 40px wide in a 390px strip, starting 175px in: the middle. */
    expect(LINKS[6].linkLeft - scrollLeft).toBe(175);
  });

  it("stays at 0 when the strip is not scrollable at all", () => {
    /* The desktop case, and the mid-resize case where scrollWidth is briefly
       reported smaller than the viewport. A negative maxScroll here would send
       the strip backwards. */
    expect(
      centredScrollLeft({ linkLeft: 706, linkWidth: 43, viewportWidth: 1200, scrollWidth: 774 }),
    ).toBe(0);
  });
});

describe("scrollEdges — a fade only where there is really more", () => {
  it("at rest: more to the right, nothing to the left", () => {
    expect(scrollEdges({ scrollLeft: 0, viewportWidth: VIEWPORT, scrollWidth: SCROLL_WIDTH })).toEqual(
      { left: false, right: true },
    );
  });

  it("scrolled to the end: nothing to the right, more to the left", () => {
    expect(
      scrollEdges({ scrollLeft: MAX_SCROLL, viewportWidth: VIEWPORT, scrollWidth: SCROLL_WIDTH }),
    ).toEqual({ left: true, right: false });
  });

  it("in the middle: both", () => {
    expect(
      scrollEdges({ scrollLeft: 322, viewportWidth: VIEWPORT, scrollWidth: SCROLL_WIDTH }),
    ).toEqual({ left: true, right: true });
  });

  /* ─── The reason for the 1px tolerance ────────────────────────────────────
     On a device with a fractional pixel ratio the end of the strip is reached at
     383.6, not 384. Without the tolerance the right-hand fade would still be
     drawn there — a fade promising content that does not exist, which is worse
     than no fade, because it makes a customer swipe at nothing. */
  it("treats a fractional end as the end", () => {
    expect(
      scrollEdges({ scrollLeft: 383.6, viewportWidth: VIEWPORT, scrollWidth: SCROLL_WIDTH }),
    ).toEqual({ left: true, right: false });
  });

  it("a strip that fits gets no fades", () => {
    expect(scrollEdges({ scrollLeft: 0, viewportWidth: 1200, scrollWidth: 774 })).toEqual({
      left: false,
      right: false,
    });
  });
});
