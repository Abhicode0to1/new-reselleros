/**
 * What a push says, and when a subscription should be thrown away.
 *
 * Pure and unit-tested, because the second half of this file is a delete decision made
 * from an HTTP status code, and getting that wrong deletes real subscriptions.
 */

/** The events this app is allowed to interrupt someone's phone for. */
export type PushEvent =
  | { kind: "attendance_checkin";  name?: string | null }
  | { kind: "attendance_checkout"; name?: string | null }
  | { kind: "new_lead";            company: string; value?: number | null }
  | { kind: "payment_received";    amount: number; customer: string }
  | { kind: "quote_accepted";      quoteId: string; customer: string }
  | { kind: "test" }
  /** An announcement or promotion, written by a human in the app. */
  | { kind: "offer"; title: string; body: string; url?: string };

/**
 * The two kinds of push, and why the split lives in the data rather than in good
 * intentions.
 *
 * A browser grants ONE notification permission per site, so an offer and an attendance
 * reminder arrive through the same door. Somebody annoyed by the offer does not turn off
 * offers — they turn off notifications, and the payment alert goes with them. So every
 * event declares its category, every device records what it agreed to, and the send path
 * refuses anything the device did not ask for.
 */
export type PushCategory = "operational" | "offers";

export function categoryFor(event: PushEvent): PushCategory {
  return event.kind === "offer" ? "offers" : "operational";
}

/** Does this device want this category? Missing or unreadable consent means no. */
export function deviceWants(
  categories: readonly string[] | null | undefined,
  category: PushCategory,
): boolean {
  return Array.isArray(categories) && categories.includes(category);
}

export interface PushPayload {
  title: string;
  body: string;
  /** Where a tap goes. Always a path on this app, never an absolute URL. */
  url: string;
  /**
   * Collapse key. A second notification with the same tag REPLACES the first on the lock
   * screen instead of stacking under it — so a cron that fires twice leaves one reminder,
   * not two. Money events get a UNIQUE tag: two payments are two facts, and collapsing
   * them would hide one.
   */
  tag: string;
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * A path on THIS app — one leading slash and no second one.
 *
 * The second condition is the whole function: `//evil.example` starts with a slash and is
 * a protocol-relative url the browser resolves against a different host. The service
 * worker refuses cross-origin too, so this is the inner of two guards; both exist because
 * the offer payload is the one a person types.
 */
function isAppPath(url: string | undefined): boolean {
  return Boolean(url) && url!.startsWith("/") && !url!.startsWith("//");
}

export function pushPayload(event: PushEvent): PushPayload {
  switch (event.kind) {
    case "attendance_checkin":
      return {
        title: "Attendance — check in",
        body: `${event.name ? `${event.name}, ` : ""}your check-in for today is not recorded yet.`,
        url: "/attendance/me",
        /* One per day per kind: a reminder repeated at 10:00 and 11:00 should look like
           one nag that moved, not two nags. */
        tag: "attendance-checkin",
      };

    case "attendance_checkout":
      return {
        title: "Attendance — check out",
        body: "You are still checked in. Tap to close today's attendance.",
        url: "/attendance/me",
        tag: "attendance-checkout",
      };

    case "new_lead":
      return {
        title: "New lead",
        body: event.value
          ? `${event.company} · ${inr(event.value)}`
          : event.company,
        url: "/leads",
        tag: "new-lead",
      };

    case "payment_received":
      return {
        title: `Payment received · ${inr(event.amount)}`,
        body: `From ${event.customer}.`,
        url: "/payments",
        /* Unique per amount+customer: two payments are two facts. A shared tag would
           replace the first on the lock screen and one of them would be gone before
           anybody saw it. */
        tag: `payment-${event.customer}-${Math.round(event.amount)}`,
      };

    case "quote_accepted":
      return {
        title: "Quote accepted",
        body: `${event.customer} accepted ${event.quoteId}.`,
        url: `/quotes/${event.quoteId}`,
        tag: `quote-accepted-${event.quoteId}`,
      };

    case "offer":
      /* Author-written text, so the shape is checked here rather than trusted: an empty
         title would render as a nameless grey box, and a url that is not a path on this
         app is dropped — a promotional push is the likeliest place for a link to point
         somewhere else, and the service worker refuses cross-origin anyway. Belt and
         braces, because this is the one payload a person types. */
      return {
        title: event.title.trim() || "ResellerOS",
        body: event.body.trim(),
        /* `startsWith("/")` alone is not enough, and the test caught it: `//evil.example`
           begins with a slash and is a PROTOCOL-RELATIVE url — the browser reads it as a
           different host. So a second slash disqualifies it. */
        url: isAppPath(event.url) ? event.url! : "/dashboard",
        /* Unique per message: two announcements are two announcements, and collapsing
           them would silently drop one. */
        tag: `offer-${event.title.trim().slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      };

    case "test":
      return {
        title: "ResellerOS notifications are on",
        body: "This is a test. Real alerts will look like this.",
        url: "/settings",
        tag: "push-test",
      };
  }
}

/** What to do with a subscription after the push service answered. */
export type PushDisposition = "keep" | "delete" | "config-error";

/**
 * A push service's status code, turned into a decision about the stored row.
 *
 * ─── THE ONE THAT MATTERS ───────────────────────────────────────────────────
 * 404 and 410 mean the endpoint is permanently gone — app uninstalled, site data
 * cleared. Those rows must be deleted or every future send retries garbage forever.
 *
 * 401 and 403 mean the VAPID key is wrong. That is OUR misconfiguration, and every
 * subscription fails at once — so deleting on those codes would wipe every device in
 * the tenant on the first bad deploy, and nobody would notice until the day a
 * notification mattered. They are reported, never acted on.
 *
 * 429 and 5xx are the push service having a bad minute. Keep and try next time.
 */
export function dispositionForStatus(status: number): PushDisposition {
  if (status === 404 || status === 410) return "delete";
  if (status === 401 || status === 403) return "config-error";
  return "keep";
}

/** True when the send worked. 201 is what the Web Push spec actually returns. */
export function isPushDelivered(status: number): boolean {
  return status >= 200 && status < 300;
}
