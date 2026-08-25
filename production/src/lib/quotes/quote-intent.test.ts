import { describe, it, expect } from "vitest";
import {
  DEDUPE_SECONDS,
  HOT_LEAD_VIEWS,
  HOT_LEAD_WINDOW_MINUTES,
  detectHotLead,
  dedupeViews,
  hotLeadAlert,
  isBotUserAgent,
  type QuoteView,
} from "./quote-intent";

const NOW = new Date("2026-08-25T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const secsAgo = (s: number) => new Date(NOW.getTime() - s * 1_000);

const view = (at: Date, over: Partial<QuoteView> = {}): QuoteView => ({
  viewedAt: at,
  isBot: false,
  viewerHash: "viewer-a",
  ...over,
});

describe("isBotUserAgent — the link previews that will actually happen", () => {
  it.each([
    ["WhatsApp/2.24.1", "WhatsApp fetching a preview card"],
    ["facebookexternalhit/1.1", "Meta's crawler behind WhatsApp and Messenger"],
    ["Slackbot-LinkExpanding 1.0", "Slack unfurling the link"],
    ["TelegramBot (like TwitterBot)", "Telegram"],
    ["LinkedInBot/1.0", "LinkedIn"],
  ])("treats %s as a machine (%s)", (ua) => {
    expect(isBotUserAgent(ua)).toBe(true);
  });

  it("treats a MISSING user-agent as a machine", () => {
    /* Every real browser sends one. Something that does not is a script, and a script must not
       be able to manufacture interest and summon a rep. */
    expect(isBotUserAgent(null)).toBe(true);
    expect(isBotUserAgent("")).toBe(true);
    expect(isBotUserAgent("   ")).toBe(true);
  });

  it.each([
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126.0 Mobile Safari/537.36",
  ])("lets a real browser through", (ua) => {
    expect(isBotUserAgent(ua)).toBe(false);
  });

  it("catches curl and headless browsers", () => {
    expect(isBotUserAgent("curl/8.4.0")).toBe(true);
    expect(isBotUserAgent("Mozilla/5.0 HeadlessChrome/126.0")).toBe(true);
  });
});

describe("dedupeViews — a refresh is not a second read", () => {
  it("collapses a burst from one viewer", () => {
    /* A phone that sleeps and wakes reloads the page; somebody tapping back and forward
       "views" three times in a minute without leaving. */
    const kept = dedupeViews([view(secsAgo(30)), view(secsAgo(20)), view(secsAgo(10))]);
    expect(kept).toHaveLength(1);
  });

  it("keeps views far enough apart to be a real return", () => {
    const kept = dedupeViews([view(minsAgo(9)), view(minsAgo(6)), view(minsAgo(2))]);
    expect(kept).toHaveLength(3);
  });

  it(`draws the line at ${DEDUPE_SECONDS} seconds`, () => {
    expect(dedupeViews([view(secsAgo(DEDUPE_SECONDS + 1)), view(NOW)])).toHaveLength(2);
    expect(dedupeViews([view(secsAgo(DEDUPE_SECONDS - 1)), view(NOW)])).toHaveLength(1);
  });

  it("counts two different viewers separately even in the same second", () => {
    /* The customer on a phone and their colleague on a laptop are two people reading it. */
    const kept = dedupeViews([
      view(secsAgo(5), { viewerHash: "phone" }),
      view(secsAgo(5), { viewerHash: "laptop" }),
    ]);
    expect(kept).toHaveLength(2);
  });

  it("never merges two ANONYMOUS views", () => {
    /* Two fetches with nothing to key on could be two different people, and merging them
       under-counts — which costs a call rather than credibility. */
    const kept = dedupeViews([
      view(secsAgo(5), { viewerHash: null }),
      view(secsAgo(4), { viewerHash: null }),
    ]);
    expect(kept).toHaveLength(2);
  });

  it("drops machines before counting anything", () => {
    const kept = dedupeViews([
      view(minsAgo(5), { isBot: true, viewerHash: "wa" }),
      view(minsAgo(3), { isBot: true, viewerHash: "wa" }),
      view(minsAgo(1)),
    ]);
    expect(kept).toHaveLength(1);
  });
});

describe("detectHotLead", () => {
  const base = { now: NOW, alreadyAlertedAt: null };

  it(`fires on ${HOT_LEAD_VIEWS} real views inside ${HOT_LEAD_WINDOW_MINUTES} minutes`, () => {
    const v = detectHotLead({
      ...base,
      views: [view(minsAgo(8)), view(minsAgo(5)), view(minsAgo(2))],
    });
    expect(v.hot).toBe(true);
    expect(v.humanViews).toBe(3);
  });

  it("does NOT fire on three link previews", () => {
    /* THE TEST THIS MODULE EXISTS FOR. Paste the quote link into WhatsApp and Meta fetches the
       page; forward it and it happens again. Three of those are not a customer reading a
       quote, and a rep rung about them stops trusting the next alert. */
    const v = detectHotLead({
      ...base,
      views: [
        view(minsAgo(8), { isBot: true }),
        view(minsAgo(5), { isBot: true }),
        view(minsAgo(2), { isBot: true }),
      ],
    });
    expect(v.hot).toBe(false);
    expect(v.humanViews).toBe(0);
    expect(v.botViews).toBe(3);
    expect(v.reason).toContain("link previews, not people");
  });

  it("does NOT fire on one person refreshing three times", () => {
    const v = detectHotLead({
      ...base,
      views: [view(secsAgo(40)), view(secsAgo(25)), view(secsAgo(5))],
    });
    expect(v.hot).toBe(false);
    expect(v.humanViews).toBe(1);
  });

  it("ignores views outside the window", () => {
    const v = detectHotLead({
      ...base,
      views: [view(minsAgo(60)), view(minsAgo(45)), view(minsAgo(2))],
    });
    expect(v.hot).toBe(false);
    expect(v.humanViews).toBe(1);
  });

  it("refuses a SECOND alert for the same quote", () => {
    /* The once-only stamp, and it is checked before any counting. On 24 Aug an alert whose
       query ignored state re-fired on every sweep for a ticket already handled; ten opens must
       not produce eight alerts. */
    const v = detectHotLead({
      views: [view(minsAgo(8)), view(minsAgo(5)), view(minsAgo(2))],
      now: NOW,
      alreadyAlertedAt: minsAgo(30),
    });
    expect(v.hot).toBe(false);
    expect(v.reason).toContain("one alert per quote");
  });

  it("still reports the counts when it refuses, so the log is readable", () => {
    const v = detectHotLead({
      views: [view(minsAgo(2)), view(minsAgo(2), { isBot: true })],
      now: NOW,
      alreadyAlertedAt: minsAgo(30),
    });
    expect(v.totalViews).toBe(2);
    expect(v.botViews).toBe(1);
  });

  it("counts two colleagues reading it at once as two", () => {
    /* The realistic hot lead: forwarded internally and opened by three people in a meeting. */
    const v = detectHotLead({
      ...base,
      views: [
        view(minsAgo(3), { viewerHash: "a" }),
        view(minsAgo(3), { viewerHash: "b" }),
        view(minsAgo(2), { viewerHash: "c" }),
      ],
    });
    expect(v.hot).toBe(true);
  });
});

describe("hotLeadAlert", () => {
  const verdict = detectHotLead({
    views: [view(minsAgo(8)), view(minsAgo(5)), view(minsAgo(2)), view(minsAgo(4), { isBot: true })],
    now: NOW,
    alreadyAlertedAt: null,
  });

  it("names the customer, the quote and the amount", () => {
    const a = hotLeadAlert({
      customerName: "Rahul Solutions",
      quoteId: "Q-ADPL-2026-27-0058",
      amount: 146_811,
      verdict,
    });
    expect(a.subject).toContain("Rahul Solutions");
    expect(a.body).toContain("Q-ADPL-2026-27-0058");
    expect(a.body).toContain("Rs 1,46,811");
  });

  it("states the preview count beside the real one", () => {
    /* A rep told "3 views" who later learns two were WhatsApp fetches stops trusting the next
       alert, and this feature only works while it is trusted. */
    const a = hotLeadAlert({ customerName: "Rahul Solutions", quoteId: "Q-1", amount: 1000, verdict });
    expect(a.body).toContain("link preview");
  });

  it("does not shout", () => {
    /* "Call them NOW!" was in the brief and is left out: an alert that shouts every time
       trains the reader to skim it, and "read it three times in ten minutes" is already the
       loudest thing in the message. */
    const a = hotLeadAlert({ customerName: "Rahul Solutions", quoteId: "Q-1", amount: 1000, verdict });
    expect(a.body).not.toContain("!");
    expect(a.body).not.toContain("NOW");
    expect(a.subject).not.toContain("🚨");
  });

  it("copes with a customer we have no name for", () => {
    const a = hotLeadAlert({ customerName: "  ", quoteId: "Q-1", amount: 1000, verdict });
    expect(a.subject).toContain("A customer");
  });
});
