/**
 * Where a lead came from — the Source dropdown on Add / Edit lead.
 *
 * Pardeep, 26 Sep 2026: "zaroori platform bhi daalo jaise Facebook". The list had seven
 * entries, three of which describe how the lead was typed in rather than where it came
 * from, and no Facebook, LinkedIn, IndiaMART or JustDial at all.
 *
 * The VALUES are not free text: Marketing → ROAS & CAC puts a channel's spend
 * (`expenses.channel`, keys in lib/marketing/ad-channels.ts) against the leads whose
 * `source` has the same key. A Facebook lead saved as "facebook" while its ad bill says
 * "meta-ads" would be spend with no leads and leads with no spend. So every paid channel
 * an expense can be tagged with exists here under the same key (lead-sources.test.ts).
 *
 * Paid and unpaid are separate entries on purpose: a lead from a Facebook AD has a cost
 * per lead; one who found the Facebook PAGE does not, and one row for both would make
 * the ad look better than it is.
 */

export interface LeadSource { value: string; label: string }

export const LEAD_SOURCES: readonly LeadSource[] = [
  // Paid — these carry spend (same keys as AD_CHANNELS)
  { value: "google-ads",       label: "Google Ads" },
  { value: "meta-ads",         label: "Facebook / Instagram Ads" },
  { value: "linkedin-ads",     label: "LinkedIn Ads" },
  { value: "indiamart",        label: "IndiaMART" },
  { value: "justdial",         label: "JustDial" },
  // Found us without an ad
  { value: "google-organic",   label: "Google search / SEO" },
  { value: "meta-organic",     label: "Facebook / Instagram page (bina ad)" },
  { value: "linkedin-organic", label: "LinkedIn (bina ad)" },
  { value: "youtube-organic",  label: "YouTube" },
  { value: "enquiry-form",     label: "Website enquiry form" },
  { value: "buy-workspace-v2", label: "Buy Workspace page" },
  // Direct
  { value: "whatsapp",         label: "WhatsApp" },
  { value: "referral",         label: "Referral" },
  { value: "tele-calling",     label: "Tele calling" },
  { value: "email-outreach",   label: "Email outreach" },
  { value: "email-inbound",    label: "Email (unhone bheja)" },
  { value: "trade-show",       label: "Trade show / event" },
  { value: "walk-in",          label: "Walk-in / office visit" },
  // How it was entered — not a channel (channel-economics reports these apart)
  { value: "manual",           label: "Added manually" },
  { value: "csv",              label: "CSV import" },
];

/**
 * The options to show for a lead whose saved source may be one this list no longer
 * names (an old import, a form tag). Kept visible rather than shown blank, so opening
 * and saving a lead never silently rewrites where it came from.
 */
export function sourceOptions(current: string | null | undefined): readonly LeadSource[] {
  const c = (current ?? "").trim();
  if (!c || LEAD_SOURCES.some((s) => s.value === c)) return LEAD_SOURCES;
  return [...LEAD_SOURCES, { value: c, label: c }];
}

export function sourceLabel(value: string | null | undefined): string {
  return LEAD_SOURCES.find((s) => s.value === value)?.label ?? (value || "—");
}
