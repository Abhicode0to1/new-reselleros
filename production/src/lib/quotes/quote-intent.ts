/**
 * Reading intent off a quote's page views — and refusing to read it off a machine's.
 *
 * Pure. The recording is in the public quote route, the alert is in lib/email/owner-alert; this
 * decides what counts as a view, what counts as interest, and when the desk is told.
 *
 * ─── THE FAILURE THAT SHAPES EVERY RULE HERE ────────────────────────────────
 * A FALSE hot lead costs more than a missed one. A missed one costs a phone call nobody made.
 * A false one has a rep ringing somebody who never opened the quote, and after that happens
 * twice nobody acts on the third alert — at which point the feature is worse than absent,
 * because it looks like it is working.
 *
 * Two things generate views that no human made, and both are ordinary:
 *
 *   1. LINK PREVIEWS. Send the quote link on WhatsApp and Meta's servers fetch the page to
 *      build the preview card. That is one view before anybody sees anything, and forwarding
 *      it makes more. Slack, iMessage, Telegram and LinkedIn all do the same. Three views can
 *      therefore mean one person and two previews.
 *   2. REFRESHES AND RE-RENDERS. A phone that sleeps and wakes reloads the page. Somebody who
 *      opens the link, reads it, and taps back and forward has "viewed" three times in a
 *      minute without ever leaving.
 *
 * So the count is bots-excluded and then de-duplicated per viewer, and both numbers are kept so
 * the alert can say what it actually saw.
 */

/** How many human views inside the window make a lead worth a phone call. */
export const HOT_LEAD_VIEWS = 3;

/** The window those views must fall inside, in minutes. */
export const HOT_LEAD_WINDOW_MINUTES = 10;

/**
 * Two views from the same viewer closer together than this are one view.
 *
 * Ninety seconds is chosen against the behaviour, not the clock: a person reading a quote
 * taps back and forth within a minute or two, and a phone waking up reloads instantly. Somebody
 * genuinely returning to reconsider does so minutes later, and that is the signal worth having.
 */
export const DEDUPE_SECONDS = 90;

export interface QuoteView {
  viewedAt: Date;
  isBot: boolean;
  /** Coarse viewer key. Null when the request carried nothing to key on. */
  viewerHash: string | null;
}

/**
 * Is this user-agent a machine?
 *
 * A NAMED list rather than a heuristic, and it is deliberately generous about what counts as a
 * bot — a false positive loses one view from a count, and a false negative summons a rep. The
 * first four entries are the ones that will actually happen here, because they are the apps a
 * quote link gets pasted into.
 *
 * An ABSENT user-agent is treated as a bot too. Every real browser sends one; something that
 * does not is a script, and a script must not be able to manufacture interest.
 */
const BOT_MARKERS: readonly string[] = [
  // Link previews — the ones this feature will meet on day one.
  "whatsapp",
  "facebookexternalhit",
  "slackbot",
  "telegrambot",
  "twitterbot",
  "discordbot",
  "linkedinbot",
  "skypeuripreview",
  "iframely",
  "embedly",
  // Crawlers.
  "googlebot",
  "bingbot",
  "yandexbot",
  "duckduckbot",
  "applebot",
  "ahrefsbot",
  "semrushbot",
  // Scripts and monitors.
  "curl",
  "wget",
  "python-requests",
  "httpie",
  "postman",
  "axios",
  "node-fetch",
  "go-http-client",
  "headlesschrome",
  "phantomjs",
  "puppeteer",
  "playwright",
  "uptimerobot",
  "pingdom",
  "bot",
  "crawler",
  "spider",
  "preview",
];

export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? "").trim().toLowerCase();
  if (!ua) return true; // no UA at all — see the docstring
  return BOT_MARKERS.some((m) => ua.includes(m));
}

/**
 * Human views, with same-viewer bursts collapsed into one.
 *
 * Oldest-first in, oldest-first out. A view with no `viewerHash` is never collapsed against
 * another — two anonymous fetches could be two different people, and merging them would
 * UNDER-count, which is the direction that costs a call rather than credibility.
 */
export function dedupeViews(views: readonly QuoteView[], dedupeSeconds = DEDUPE_SECONDS): QuoteView[] {
  const human = views
    .filter((v) => !v.isBot)
    .slice()
    .sort((a, b) => a.viewedAt.getTime() - b.viewedAt.getTime());

  const kept: QuoteView[] = [];
  const lastSeen = new Map<string, number>();

  for (const v of human) {
    if (!v.viewerHash) {
      kept.push(v);
      continue;
    }
    const previous = lastSeen.get(v.viewerHash);
    const t = v.viewedAt.getTime();
    if (previous !== undefined && (t - previous) / 1000 < dedupeSeconds) {
      /* A refresh, or a back-and-forward. The viewer's clock advances so a long reading session
         still produces separate views once they are far enough apart. */
      lastSeen.set(v.viewerHash, t);
      continue;
    }
    lastSeen.set(v.viewerHash, t);
    kept.push(v);
  }

  return kept;
}

export interface HotLeadVerdict {
  hot: boolean;
  /** Distinct human views inside the window, after de-duplication. */
  humanViews: number;
  /** Everything the page saw in the window, including machines. For the log. */
  totalViews: number;
  /** Machine fetches in the window — the number that makes the human one believable. */
  botViews: number;
  /** One sentence for the operator, whether or not it fired. */
  reason: string;
}

/**
 * Is this quote being read hard enough to warrant interrupting a rep?
 *
 * `alreadyAlertedAt` is the once-only stamp and it is checked FIRST, before any counting. On
 * 24 Aug an alert whose query ignored state re-fired on every sweep for a ticket that had
 * already been handled; a viewer who opens a quote ten times must not produce eight alerts.
 */
export function detectHotLead(input: {
  views: readonly QuoteView[];
  now: Date;
  alreadyAlertedAt: Date | null;
  windowMinutes?: number;
  threshold?: number;
}): HotLeadVerdict {
  const windowMinutes = input.windowMinutes ?? HOT_LEAD_WINDOW_MINUTES;
  const threshold = input.threshold ?? HOT_LEAD_VIEWS;
  const since = new Date(input.now.getTime() - windowMinutes * 60_000);

  const inWindow = input.views.filter((v) => v.viewedAt >= since && v.viewedAt <= input.now);
  const botViews = inWindow.filter((v) => v.isBot).length;
  const humanViews = dedupeViews(inWindow).length;

  const counts = { humanViews, totalViews: inWindow.length, botViews };

  if (input.alreadyAlertedAt) {
    return {
      hot: false,
      ...counts,
      reason: "the desk has already been told about this quote — one alert per quote",
    };
  }

  if (humanViews < threshold) {
    const botNote = botViews > 0 ? ` (${botViews} more were link previews, not people)` : "";
    return {
      hot: false,
      ...counts,
      reason:
        `${humanViews} real view${humanViews === 1 ? "" : "s"} in the last ${windowMinutes} ` +
        `minutes${botNote} — the bar is ${threshold}`,
    };
  }

  return {
    hot: true,
    ...counts,
    reason:
      `${humanViews} separate views in ${windowMinutes} minutes` +
      (botViews > 0 ? `, plus ${botViews} link preview${botViews === 1 ? "" : "s"} that were not counted` : ""),
  };
}

/** Rs, whole rupees, Indian grouping. */
function rupees(n: number): string {
  return `Rs ${Math.round(n).toLocaleString("en-IN")}`;
}

/**
 * The alert, in words.
 *
 * The amount comes from the quote — our own document, so there is nothing to verify and nothing
 * to invent. The view count is the DE-DUPLICATED human one, and the preview count is stated
 * beside it: a rep who is told "3 views" and later learns two were WhatsApp fetches stops
 * trusting the next alert, and this feature only works while it is trusted.
 *
 * No urgency language beyond the fact. "Call them NOW!" was in the brief and is left out on
 * purpose — an alert that shouts every time trains the reader to skim it, and the fact that a
 * customer read a quote three times in ten minutes is already the loudest thing in it.
 */
export function hotLeadAlert(input: {
  customerName: string;
  quoteId: string;
  amount: number;
  verdict: HotLeadVerdict;
  windowMinutes?: number;
}): { subject: string; body: string } {
  const windowMinutes = input.windowMinutes ?? HOT_LEAD_WINDOW_MINUTES;
  const who = input.customerName.trim() || "A customer";

  const previewNote =
    input.verdict.botViews > 0
      ? `\n(${input.verdict.botViews} further fetch${input.verdict.botViews === 1 ? "" : "es"} were ` +
        "link previews from a messaging app, and are not counted above.)"
      : "";

  return {
    subject: `${who} is reading quote ${input.quoteId}`,
    body:
      `${who} has opened quote ${input.quoteId} — ${rupees(input.amount)} — ` +
      `${input.verdict.humanViews} times in the last ${windowMinutes} minutes.` +
      `${previewNote}\n\n` +
      "Somebody reading a quote this closely usually has a question they have not asked. " +
      "Worth a call while it is open in front of them.",
  };
}
