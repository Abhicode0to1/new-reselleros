/**
 * Which marketing channel an expense paid for — so the Marketing → ROAS & CAC report can
 * put ad spend next to the leads that channel brought in.
 *
 * `expenses.channel` has existed since migration 0232, but nothing in Add expense ever
 * wrote it, so every marketing rupee landed untagged and the report showed ₹0 spend
 * (Pardeep, 26 Sep 2026). The keys here are the ones `channel-economics.ts` matches
 * against `leads.source` and `utm.ts` maps utm_source to — a spend key that no lead
 * uses would be spend with nothing to divide it by.
 */

export interface AdChannel { value: string; label: string }

export const AD_CHANNELS: readonly AdChannel[] = [
  { value: "google-ads",     label: "Google Ads" },
  { value: "meta-ads",       label: "Facebook / Instagram Ads" },
  { value: "linkedin-ads",   label: "LinkedIn Ads" },
  { value: "whatsapp",       label: "WhatsApp" },
  { value: "email-outreach", label: "Email outreach" },
  { value: "tele-calling",   label: "Tele calling" },
  { value: "referral",       label: "Referral" },
  { value: "trade-show",     label: "Trade show / event" },
];

/** The same test the report uses to decide an expense is marketing spend. */
export function isMarketingCategory(category: string | null | undefined): boolean {
  return /market|advert|ads/i.test(category ?? "");
}

/* Vendor / description words that name the channel outright. Kept short on purpose —
   a guess is only offered, never saved without the operator seeing it. */
const HINTS: ReadonlyArray<[RegExp, string]> = [
  [/\b(google|adwords|gads)\b/i,                    "google-ads"],
  [/\b(facebook|fb|meta|instagram|insta)\b/i,       "meta-ads"],
  [/\blinked ?in\b/i,                               "linkedin-ads"],
  [/\b(whatsapp|wati|interakt|aisensy|gupshup)\b/i, "whatsapp"],
  [/\b(mailchimp|sendgrid|brevo|sendinblue|zoho campaigns)\b/i, "email-outreach"],
  [/\b(expo|exhibition|trade ?show|event)\b/i,      "trade-show"],
];

/** The channel the bill's own words point to, or null when they point nowhere. */
export function suggestAdChannel(text: string | null | undefined): string | null {
  const t = text ?? "";
  for (const [re, ch] of HINTS) if (re.test(t)) return ch;
  return null;
}
