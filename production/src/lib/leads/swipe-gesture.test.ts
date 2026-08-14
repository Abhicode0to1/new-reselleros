import { describe, it, expect } from "vitest";
import { decideSwipe, SWIPE_TRIGGER_PX, SWIPE_VELOCITY, type SwipeInput } from "./swipe-gesture";

const swipe = (over: Partial<SwipeInput> = {}): SwipeInput => ({
  dx: 0, dy: 0, vx: 0, vy: 0, hasPhone: true, stage: "new", ...over,
});

describe("decideSwipe — the three gestures", () => {
  it("right → contacted", () => {
    expect(decideSwipe(swipe({ dx: 100 })).action).toBe("contacted");
  });

  it("left → snooze to tomorrow", () => {
    expect(decideSwipe(swipe({ dx: -100 })).action).toBe("snooze");
  });

  it("up → WhatsApp", () => {
    expect(decideSwipe(swipe({ dy: -100 })).action).toBe("whatsapp");
  });

  it("DOWN does nothing — the most common accidental gesture in a scrolling list", () => {
    /* Inventing a fourth action for a downward flick would guarantee misfires. */
    const r = decideSwipe(swipe({ dy: 100 }));
    expect(r.action).toBeNull();
    expect(r.wasDrag).toBe(true);      // still swallows the tap
  });
});

describe("decideSwipe — thresholds", () => {
  it("fires exactly AT the distance threshold", () => {
    expect(decideSwipe(swipe({ dx: SWIPE_TRIGGER_PX })).action).toBe("contacted");
    expect(decideSwipe(swipe({ dx: SWIPE_TRIGGER_PX - 1 })).action).toBeNull();
  });

  it("a fast flick fires even when the distance is short", () => {
    expect(decideSwipe(swipe({ dx: 20, vx: SWIPE_VELOCITY })).action).toBe("contacted");
    expect(decideSwipe(swipe({ dx: 20, vx: SWIPE_VELOCITY - 1 })).action).toBeNull();
  });

  it("a small movement is a TAP — no action, and the tap is allowed through", () => {
    const r = decideSwipe(swipe({ dx: 3 }));
    expect(r.action).toBeNull();
    expect(r.wasDrag).toBe(false);
  });

  it("a half-swipe swallows the tap, so it does not open the drawer", () => {
    // Between 6px and the threshold: the rep was clearly swiping, not tapping.
    const r = decideSwipe(swipe({ dx: 40 }));
    expect(r.action).toBeNull();
    expect(r.wasDrag).toBe(true);
  });
});

describe("decideSwipe — the dominant axis wins, and only one action fires", () => {
  it("a diagonal is ONE gesture, not two", () => {
    // More vertical than horizontal → WhatsApp, not WhatsApp *and* contacted.
    expect(decideSwipe(swipe({ dx: 90, dy: -120 })).action).toBe("whatsapp");
    // More horizontal → contacted.
    expect(decideSwipe(swipe({ dx: 120, dy: -90 })).action).toBe("contacted");
  });

  it("judges velocity on the SAME axis it judged distance", () => {
    /* The bug this pins: taking distance from the dominant axis but velocity from x
       would let a slow upward drag fire because the finger happened to move sideways
       quickly at the end. */
    const r = decideSwipe(swipe({ dx: 10, dy: -30, vx: 900, vy: 10 }));
    expect(r.action).toBeNull();
  });
});

describe("decideSwipe — a swipe can never move a lead BACKWARDS", () => {
  it.each(["demo", "trial", "quote", "won", "lost"])(
    "refuses to set a %s deal back to contacted, and says why",
    (stage) => {
      /* The worst thing a gesture can do is delete real funnel progress. A ₹5L quote
         reverting to "contacted" because a thumb brushed the card is not recoverable by
         noticing — nobody notices. */
      const r = decideSwipe(swipe({ dx: 100, stage }));
      expect(r.action).toBeNull();
      expect(r.refusal).toContain("already past contact");
      expect(r.refusal).toContain(stage);
    },
  );

  it("is a no-op when the lead is ALREADY contacted", () => {
    const r = decideSwipe(swipe({ dx: 100, stage: "contact" }));
    expect(r.action).toBeNull();
    expect(r.refusal).toBe("Already marked contacted.");
  });

  it("still allows it from `new`, and from an unknown/missing stage", () => {
    expect(decideSwipe(swipe({ dx: 100, stage: "new" })).action).toBe("contacted");
    for (const stage of [null, undefined, ""]) {
      expect(decideSwipe(swipe({ dx: 100, stage })).action).toBe("contacted");
    }
  });

  it("does NOT block the other two gestures on an advanced deal", () => {
    // Snoozing or WhatsApping a quote-stage deal is perfectly normal.
    expect(decideSwipe(swipe({ dx: -100, stage: "quote" })).action).toBe("snooze");
    expect(decideSwipe(swipe({ dy: -100, stage: "quote" })).action).toBe("whatsapp");
  });
});

describe("decideSwipe — no phone", () => {
  it("refuses every gesture and explains, rather than failing silently", () => {
    for (const g of [{ dx: 100 }, { dx: -100 }, { dy: -100 }]) {
      const r = decideSwipe(swipe({ ...g, hasPhone: false }));
      expect(r.action).toBeNull();
      expect(r.refusal).toMatch(/No phone number/);
      expect(r.wasDrag).toBe(true);
    }
  });

  it("does not fire a refusal toast for a mere tap", () => {
    // Otherwise every tap on a phoneless lead would scold the rep before opening it.
    const r = decideSwipe(swipe({ dx: 2, hasPhone: false }));
    expect(r.refusal).toBeNull();
    expect(r.wasDrag).toBe(false);
  });
});
