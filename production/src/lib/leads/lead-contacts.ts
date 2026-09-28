/**
 * AI Lead Finder — "contact dhoondho" (28 Sep 2026).
 *
 * A found company is useless to a telecaller without a way to reach it. This reads the
 * company's OWN website (home, contact, about) and keeps only what the company publishes
 * there for business enquiries: mailto:/tel: links first, then addresses and Indian phone
 * numbers written in the page text.
 *
 * Deliberately NOT done: guessing addresses (rahul@domain.com), third-party directories,
 * LinkedIn or Maps scraping. A guessed address bounces and hurts our sending domain; a
 * scraped personal number is exactly the kind of data the page promises not to use.
 *
 * Pure functions only — the fetching lives in lead-finder.server.ts.
 */

export interface FoundContacts {
  emails: string[];
  phones: string[];
}

/* A type alias, not an interface, so it fits the jsonb `signals` column's Json type. */
export type ContactResult = {
  email: string | null;
  phone: string | null;
  emails: string[];
  phones: string[];
  /** page the best email/phone came from */
  source_url: string | null;
  checked_at: string;
};

/** Pages worth reading, in order. The home page is read first by the caller. */
export const CONTACT_PATHS = ["/contact", "/contact-us", "/about-us", "/contactus", "/about"] as const;

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const ASSET_TAIL = /\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?)$/i;
/** Addresses that appear on sites but never reach the company. */
const JUNK_DOMAIN = /(^|\.)(example\.(com|org)|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|domain\.com|email\.com|yourdomain\.com|godaddy\.com|w3\.org|schema\.org)$/i;
const JUNK_LOCAL = /^(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|abuse|webmaster|wordpress|admin@wordpress)$/i;

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#64;|&commat;/gi, "@")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ");
}

/** "info [at] firm [dot] com" → "info@firm.com" — the common way sites hide an address. */
function unObfuscate(text: string): string {
  return text
    .replace(/\s*[[(]\s*at\s*[\])]\s*/gi, "@")
    .replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, ".");
}

export function cleanEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase().replace(/^mailto:/, "").split("?")[0].replace(/[.,;:)]+$/, "");
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return null;
  if (ASSET_TAIL.test(e)) return null;                 // logo@2x.png
  const [local, host] = e.split("@");
  if (JUNK_LOCAL.test(local) || JUNK_DOMAIN.test(host)) return null;
  return e;
}

/**
 * Indian numbers only — this is an Indian reseller and a foreign number on an Indian SME's
 * site is usually a vendor's. Mobiles → +91XXXXXXXXXX; landlines keep their STD code
 * (0XX-XXXXXXXX) so a caller can dial them as written.
 */
export function cleanPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  let d = digits.replace(/^\+/, "");
  if (d.startsWith("0091")) d = d.slice(4);
  else if (d.startsWith("91") && d.length === 12) d = d.slice(2);
  if (/^[6-9]\d{9}$/.test(d)) return "+91" + d;                               // mobile
  if (/^0[6-9]\d{9}$/.test(d)) return "+91" + d.slice(1);                      // 0 + mobile
  if (/^0[1-9]\d{8,9}$/.test(d)) return d;                                     // landline with STD
  if (/^[1-9]\d{9}$/.test(d) && digits.startsWith("+91")) return "0" + d;      // +91 11 2345 6789
  if (/^1800\d{6,7}$/.test(d)) return d;                                       // toll-free
  return null;
}

const PHONE_TEXT_RE = /(?:\+91[\s-]?|0091[\s-]?|\b0)?(?:\d[\s-]?){9,11}\d/g;

export function extractContacts(html: string, domain: string): FoundContacts {
  const emails: string[] = [], phones: string[] = [];
  const addE = (x: string) => { const e = cleanEmail(x); if (e && !emails.includes(e)) emails.push(e); };
  const addP = (x: string) => { const p = cleanPhone(x); if (p && !phones.includes(p)) phones.push(p); };

  // 1. Links the site itself marked as contact — the most reliable signal.
  for (const m of html.matchAll(/href=["']mailto:([^"'?]+)/gi)) addE(decodeURIComponent(m[1]));
  for (const m of html.matchAll(/href=["']tel:([^"']+)/gi)) addP(decodeURIComponent(m[1]));

  // 2. Written in the page text.
  const text = unObfuscate(stripTags(html));
  for (const m of text.matchAll(EMAIL_RE)) addE(m[0]);
  for (const m of text.matchAll(PHONE_TEXT_RE)) addP(m[0]);

  // Company's own domain first: info@firm.com beats the web agency's hello@agency.com.
  const own = domain.toLowerCase().replace(/^www\./, "");
  emails.sort((a, b) => Number(!a.endsWith("@" + own) && !a.endsWith("." + own)) - Number(!b.endsWith("@" + own) && !b.endsWith("." + own)));
  return { emails: emails.slice(0, 5), phones: phones.slice(0, 5) };
}

/** Best single email: own domain, and a role address (info/contact/sales) over a person's. */
export function pickEmail(emails: string[], domain: string): string | null {
  if (!emails.length) return null;
  const own = domain.toLowerCase().replace(/^www\./, "");
  const score = (e: string) =>
    (e.endsWith("@" + own) || e.endsWith("." + own) ? 0 : 10) +
    (/^(info|contact|sales|enquiry|enquiries|inquiry|hello|office|mail|support)@/.test(e) ? 0 : 1);
  return [...emails].sort((a, b) => score(a) - score(b))[0];
}

/** Mobile first — it reaches a person and takes WhatsApp; toll-free last. */
export function pickPhone(phones: string[]): string | null {
  if (!phones.length) return null;
  const score = (p: string) => (p.startsWith("+91") ? 0 : p.startsWith("1800") ? 2 : 1);
  return [...phones].sort((a, b) => score(a) - score(b))[0];
}

/** The contact block stored in lead_finder_candidates.signals.contact. */
export function readContact(signals: unknown): ContactResult | null {
  const c = (signals as { contact?: ContactResult } | null)?.contact;
  return c && typeof c === "object" && "checked_at" in c ? c : null;
}
