/* eslint-disable no-undef */
/**
 * Service worker — PUSH ONLY. It caches nothing, on purpose.
 *
 * ─── WHY NO CACHING ─────────────────────────────────────────────────────────
 * A service worker is the standard place to add offline caching, and this one
 * deliberately does not. This app shows invoice totals, outstanding balances and
 * payment status; a cached page that looks current and is not is worse than a page
 * that fails to load, because nobody doubts a number that rendered. This repo has
 * already paid for that lesson twice — a poisoned CORS response served from the
 * browser cache killed every client-side query on the deployed origin, and a stale
 * dev bundle sent someone hunting a bug in code that was already fixed.
 *
 * So the only jobs here are: receive a push, show it, and open the right screen when
 * it is tapped. If offline support is ever wanted it belongs in its own decision, with
 * its own rules about what may go stale.
 *
 * ─── WHAT A PUSH PAYLOAD LOOKS LIKE ────────────────────────────────────────
 *   { title, body, url?, tag?, id? }
 * `tag` collapses repeats: a second attendance reminder should REPLACE the first on
 * the lock screen, not stack under it. `url` is where a tap goes, and it is treated as
 * same-origin only — a push carrying an external link would be a redirect anybody with
 * the VAPID key could aim at your staff.
 */

self.addEventListener("push", (event) => {
  /** A push with no readable body still deserves to arrive — silence looks like a bug. */
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "ResellerOS";
  const options = {
    body: data.body || "",
    /* Served by a route handler, not a static file — see src/app/icon-192.png. */
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    /* Same tag = replace, not stack. Without this a cron that fires twice leaves two
       identical reminders on the lock screen and the person stops reading them. */
    tag: data.tag || "resellersos",
    renotify: Boolean(data.tag),
    data: { url: typeof data.url === "string" ? data.url : "/dashboard" },
    /* No vibration or sound override: the phone's own notification settings are the
       user's decision, not ours to escalate. */
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  /* Same-origin only. A push payload arrives from the server, but treating its `url` as
     trusted means one leaked VAPID key turns every staff phone into a redirect. */
  let target = "/dashboard";
  try {
    const parsed = new URL(event.notification.data?.url || "/dashboard", self.location.origin);
    if (parsed.origin === self.location.origin) target = parsed.pathname + parsed.search;
  } catch {
    /* keep the default */
  }

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      /* Focus a tab that is already on that screen rather than opening a second one —
         a notification that spawns duplicate tabs is how people end up with nine. */
      for (const client of clientList) {
        const url = new URL(client.url);
        if (url.pathname === target.split("?")[0] && "focus" in client) return client.focus();
      }
      /* Otherwise reuse any open window, and only then open a new one. */
      const existing = clientList[0];
      if (existing && "navigate" in existing) {
        await existing.focus();
        return existing.navigate(target);
      }
      return self.clients.openWindow(target);
    })(),
  );
});

/* Take over from a previous worker immediately, so a fixed worker is not waiting behind
   the broken one it replaced until every tab is closed. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
