/**
 * Which action a swipe on a mobile lead card means.
 *
 * Extracted from the card as a pure function because gesture code is otherwise
 * untestable — you cannot assert on a finger. Every threshold, every axis decision and
 * every refusal below has a test, which matters more here than usual: two of these
 * three gestures now WRITE to the lead.
 *
 * ─── THE MAPPING, AND WHAT CHANGED ABOUT ITS RISK ───────────────────────────
 *     right  →  contacted     (stage → contact)
 *     left   →  snooze        (follow-up → tomorrow)
 *     up     →  whatsapp      (opens wa.me)
 *
 * It used to be right = dial, left = WhatsApp. Both of those only OPENED something: a
 * mis-swipe while scrolling launched the dialler and the rep hung up, costing nothing.
 * Right-swipe now writes a stage change, so the SAME accidental gesture alters the
 * pipeline. Three things follow from that, and they are the whole reason this file
 * exists rather than an inline `if`:
 *
 *   1. Writing gestures must be undoable. The caller toasts with Undo; the underlying
 *      mutations are optimistic with rollback.
 *   2. The reveal panel must NAME the action before the gesture completes — "Contacted",
 *      not a bare tick. That label is the only warning a rep gets.
 *   3. A swipe must never be able to move a lead BACKWARDS. See `contacted` below.
 *
 * ─── AXIS ──────────────────────────────────────────────────────────────────
 * The dominant axis wins, and only one action ever fires. A diagonal flick is not two
 * gestures. Framer's `dragDirectionLock` handles the same problem at the pointer level
 * so a page scroll cannot be mistaken for an upward pull; this is the second gate.
 */

/** Anything under this, in px, is a tap. */
export const SWIPE_TRIGGER_PX = 80;
/** Fast-flick fallback when the distance is short, in px/s. */
export const SWIPE_VELOCITY = 400;

export type SwipeAction = "contacted" | "snooze" | "whatsapp" | null;

export interface SwipeInput {
  /** framer-motion PanInfo offsets and velocities. */
  dx: number; dy: number; vx: number; vy: number;
  /** wa.me and tel: both need a number; and a stage write on an uncontactable lead is
   *  pointless. No phone → no gestures at all, matching the card's `drag={false}`. */
  hasPhone: boolean;
  /** Current stage, to decide whether "contacted" is a step forward or backwards. */
  stage: string | null | undefined;
}

export interface SwipeDecision {
  action: SwipeAction;
  /** True when the gesture passed the threshold — the card must suppress its tap-open
   *  even if the action turned out to be null (a refused right-swipe is still a swipe). */
  wasDrag: boolean;
  /** Why nothing happened, for a toast. Null when an action fired or nothing moved. */
  refusal: string | null;
}

/** Stages where "contacted" would be a step BACKWARDS. */
const PAST_CONTACT: ReadonlySet<string> = new Set(["demo", "trial", "quote", "won", "lost"]);

export function decideSwipe(input: SwipeInput): SwipeDecision {
  const { dx, dy, vx, vy, hasPhone, stage } = input;

  const moved = Math.abs(dx) > 6 || Math.abs(dy) > 6;
  const vertical = Math.abs(dy) > Math.abs(dx);
  const distance = vertical ? dy : dx;
  const velocity = vertical ? vy : vx;
  const triggered =
    Math.abs(distance) >= SWIPE_TRIGGER_PX || Math.abs(velocity) >= SWIPE_VELOCITY;

  if (!triggered) {
    // Moved but not far enough: no action, but still swallow the tap so a half-swipe
    // does not open the drawer the rep was trying to swipe past.
    return { action: null, wasDrag: moved, refusal: null };
  }

  if (!hasPhone) {
    return { action: null, wasDrag: true, refusal: "No phone number on this lead — add one first." };
  }

  if (vertical) {
    /* Up → WhatsApp. DOWN DOES NOTHING, deliberately: there is no fourth action worth
       having, and a downward flick is the single most common accidental gesture in a
       scrolling list. Inventing a meaning for it would guarantee misfires. */
    if (distance < 0) return { action: "whatsapp", wasDrag: true, refusal: null };
    return { action: null, wasDrag: true, refusal: null };
  }

  if (distance > 0) {
    /* Right → Contacted, but only from a pre-contact stage.
       A lead at demo/trial/quote has self-evidently been contacted, and setting it back
       to `contact` would DELETE real funnel progress on a stray swipe — the worst thing
       a gesture can do. Already at `contact` is a no-op rather than a pointless write. */
    if (stage === "contact") {
      return { action: null, wasDrag: true, refusal: "Already marked contacted." };
    }
    if (PAST_CONTACT.has(stage ?? "")) {
      return {
        action: null, wasDrag: true,
        refusal: `This deal is already past contact (${stage}) — swiping won't move it backwards.`,
      };
    }
    return { action: "contacted", wasDrag: true, refusal: null };
  }

  // Left → snooze to tomorrow.
  return { action: "snooze", wasDrag: true, refusal: null };
}
