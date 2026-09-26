/**
 * The marketing tools a Google Workspace / Microsoft 365 reseller that also builds custom
 * software should run — and, for each, why and how it connects to this app.
 *
 * Pardeep, 26 Sep 2026: "jo tools mere paas hone chahiye is business ko chalane ke liye,
 * unko use karne ka ek system banao". This list is the advice half of Marketing → Hub; the
 * per-company state (set up? who runs it? budget?) is the `marketing_tools` table. The
 * catalogue lives in code so a better "why" reaches every company without a migration.
 *
 * `channel` is the ad-spend / lead-source key (lib/marketing/ad-channels.ts,
 * lib/leads/lead-sources.ts). Where a tool has one, the Hub sets its monthly budget
 * against this month's actual spend on that channel and links a tracking link to it.
 */

export type ToolGroup = "ads" | "listings" | "messaging" | "website" | "email" | "social";

export const TOOL_GROUPS: Record<ToolGroup, { title: string; why: string }> = {
  ads:       { title: "Paid ads",              why: "Paisa dekar leads — kharcha aur ROAS dono yahan ginte hain" },
  listings:  { title: "Listings & marketplaces", why: "Log jahan dhoondhte hain wahan dikhna" },
  messaging: { title: "WhatsApp & calling",    why: "Lead se baat — sabse zyada deal yahin band hoti hain" },
  email:     { title: "Email",                 why: "Purane leads aur customers ko yaad dilana" },
  website:   { title: "Website & tracking",    why: "Har lead ka source pakadna" },
  social:    { title: "Social (bina ad)",      why: "Bharosa banana — free reach" },
};

export interface MarketingTool {
  key: string;
  name: string;
  group: ToolGroup;
  /** One or two lines: why this business needs it. Hinglish, like the rest of the app. */
  why: string;
  /** Where the account lives, for the "open" button before an account URL is saved. */
  homeUrl: string;
  /** Spend / lead-source channel key, when the tool is one. */
  channel?: string;
  /** Where in this app the tool's work is done or measured. */
  inApp: { href: string; label: string }[];
  /** First things to do once, in order. */
  setup: string[];
}

export const MARKETING_TOOLS: readonly MarketingTool[] = [
  // ── Paid ads ──────────────────────────────────────────────────────────────
  {
    key: "meta-ads", name: "Meta Ads Manager (Facebook / Instagram)", group: "ads", channel: "meta-ads",
    why: "Local businesses ko Workspace / email ke liye target karne ka sabse sasta tareeka. Lead form ya WhatsApp click ads.",
    homeUrl: "https://adsmanager.facebook.com",
    inApp: [
      { href: "/marketing/links", label: "Ad ke liye tracking link" },
      { href: "/accounting/prepaid", label: "Top-up (advance) aur mahine ka invoice" },
      { href: "/marketing/spend", label: "Kharcha" },
    ],
    setup: [
      "Business Manager banao, payment method lagao (advance top-up hota hai)",
      "Har ad ka link Tracking links se banao — lead ka source khud lagega",
      "Top-up ko Banking reconcile mein \"Advance / prepaid\" chuno; mahine ka invoice Prepaid par book karo",
    ],
  },
  {
    key: "google-ads", name: "Google Ads", group: "ads", channel: "google-ads",
    why: "Jo abhi \"Google Workspace price\" ya \"business email\" search kar raha hai — sabse garam lead.",
    homeUrl: "https://ads.google.com",
    inApp: [
      { href: "/marketing/links", label: "Ad ke liye tracking link" },
      { href: "/marketing/reports", label: "ROAS & CAC" },
    ],
    setup: [
      "Search campaign: \"google workspace price\", \"business email india\" jaise keywords",
      "Final URL Tracking links se banao",
      "Google ka monthly invoice Expenses mein Advertising → Google Ads channel ke saath",
    ],
  },
  {
    key: "linkedin-ads", name: "LinkedIn Ads", group: "ads", channel: "linkedin-ads",
    why: "Custom software / ERP ke bade deals ke liye — decision makers yahan milte hain. Mehenga, isliye chhota budget se shuru.",
    homeUrl: "https://www.linkedin.com/campaignmanager",
    inApp: [{ href: "/marketing/links", label: "Tracking link" }],
    setup: ["Company page pehle banao", "Chhota test budget, sirf project (custom software) ke liye"],
  },
  // ── Listings ─────────────────────────────────────────────────────────────
  {
    key: "google-business", name: "Google Business Profile", group: "listings", channel: "google-organic",
    why: "\"IT company near me\" par map mein dikhna — free. Reviews yahin aate hain, aur naya customer pehle yahi dekhta hai.",
    homeUrl: "https://business.google.com",
    inApp: [{ href: "/marketing/links", label: "Website button ke liye tracking link" }],
    setup: ["Profile verify karo (address + phone)", "Har project ke baad customer se review maango", "Website link Tracking links se banao"],
  },
  {
    key: "indiamart", name: "IndiaMART", group: "listings", channel: "indiamart",
    why: "B2B buyers seedhe requirement bhejte hain. Paid package — isliye kitni leads aur kitni deal, dono naapna zaroori.",
    homeUrl: "https://seller.indiamart.com",
    inApp: [{ href: "/leads", label: "Lead ka source \"IndiaMART\" chuno" }, { href: "/marketing/spend", label: "Package ka kharcha" }],
    setup: ["Products: Google Workspace, Microsoft 365, custom software", "Har IndiaMART lead ka source \"IndiaMART\" rakho", "Package ki payment Expenses → Advertising → IndiaMART"],
  },
  {
    key: "justdial", name: "JustDial", group: "listings", channel: "justdial",
    why: "Local search se phone calls. Paid listing ho to uska kharcha vs leads dekhte raho.",
    homeUrl: "https://www.justdial.com/Free-Listing",
    inApp: [{ href: "/leads", label: "Lead ka source \"JustDial\" chuno" }],
    setup: ["Free listing se shuru", "Har JustDial call ka source \"JustDial\" rakho"],
  },
  // ── Messaging ────────────────────────────────────────────────────────────
  {
    key: "whatsapp-business", name: "WhatsApp Business (API)", group: "messaging", channel: "whatsapp",
    why: "Lead se turant baat, quote bhejna, follow-up. App ka WhatsApp inbox isi se chalta hai.",
    homeUrl: "https://business.facebook.com/wa/manage",
    inApp: [{ href: "/whatsapp", label: "WhatsApp inbox" }, { href: "/automation", label: "Auto follow-up" }],
    setup: ["Meta par WhatsApp Business number verify karo", "App mein connect karo (Settings)", "Follow-up message templates approve karwao"],
  },
  // ── Email ────────────────────────────────────────────────────────────────
  {
    key: "email-campaigns", name: "Email campaigns (app ke andar)", group: "email", channel: "email-outreach",
    why: "Purane leads ko offer, renewals se pehle yaad dilana. App se hi jaata hai — alag tool ki zaroorat nahi.",
    homeUrl: "/campaigns",
    inApp: [{ href: "/campaigns", label: "Email campaigns" }, { href: "/coupons", label: "Offer ka coupon code" }],
    setup: ["Sending domain verify karo (Resend) taaki mail spam mein na jaaye", "Har mail mein unsubscribe link khud lagta hai — hatana mat"],
  },
  // ── Website ──────────────────────────────────────────────────────────────
  {
    key: "search-console", name: "Google Search Console", group: "website", channel: "google-organic",
    why: "Website Google search mein kin shabdon par aati hai — SEO ka pehla qadam, free.",
    homeUrl: "https://search.google.com/search-console",
    inApp: [{ href: "/lead-gen", label: "Lead sources" }],
    setup: ["Website verify karo", "Sitemap submit karo"],
  },
  {
    key: "ga4", name: "Google Analytics 4", group: "website",
    why: "Website par kitne log aaye, kahan se, aur kitne ne form bhara.",
    homeUrl: "https://analytics.google.com",
    inApp: [],
    setup: ["Property banao, website par tag lagao", "Enquiry form submit ko conversion banao"],
  },
  // ── Social ───────────────────────────────────────────────────────────────
  {
    key: "facebook-page", name: "Facebook / Instagram page", group: "social", channel: "meta-organic",
    why: "Kaam ke photos, customer reviews — ad dekhne wala pehle page dekhta hai.",
    homeUrl: "https://business.facebook.com",
    inApp: [{ href: "/marketing/links", label: "Post ke liye tracking link" }],
    setup: ["Hafte mein 2 post: ek project, ek tip", "Bio ka link Tracking links se banao"],
  },
  {
    key: "linkedin-page", name: "LinkedIn company page", group: "social", channel: "linkedin-organic",
    why: "Custom software ke clients yahan company ko check karte hain.",
    homeUrl: "https://www.linkedin.com/company/setup/new",
    inApp: [{ href: "/marketing/links", label: "Post ke liye tracking link" }],
    setup: ["Page banao, team ko jodo", "Har project case study post karo"],
  },
];

export type ToolStatus = "not_started" | "setting_up" | "active" | "paused" | "not_needed";

export const TOOL_STATUS: Record<ToolStatus, { label: string; kind: "muted" | "warning" | "success" | "info" }> = {
  not_started: { label: "Shuru nahi",   kind: "muted" },
  setting_up:  { label: "Setup chal raha", kind: "warning" },
  active:      { label: "Chal raha",    kind: "success" },
  paused:      { label: "Ruka hua",     kind: "info" },
  not_needed:  { label: "Zaroorat nahi", kind: "muted" },
};

export interface ToolState {
  tool_key: string;
  status: ToolStatus;
  account_url: string | null;
  owner_name: string | null;
  monthly_budget: number;
  notes: string | null;
}

export interface ToolRow extends MarketingTool {
  state: ToolState;
  /** This month's recorded spend on the tool's channel, or null when it has no channel. */
  spentThisMonth: number | null;
}

/** Catalogue + saved state + this month's spend → one row per tool, catalogue order. */
export function mergeTools(
  saved: ToolState[],
  spendByChannel: Record<string, number>,
): ToolRow[] {
  const byKey = new Map(saved.map((s) => [s.tool_key, s]));
  return MARKETING_TOOLS.map((t) => ({
    ...t,
    state: byKey.get(t.key) ?? {
      tool_key: t.key, status: "not_started", account_url: null, owner_name: null, monthly_budget: 0, notes: null,
    },
    spentThisMonth: t.channel ? (spendByChannel[t.channel] ?? 0) : null,
  }));
}

/** The Hub's headline: how many tools are live, and budget against spend. */
export function hubSummary(rows: ToolRow[]) {
  const counted = rows.filter((r) => r.state.status !== "not_needed");
  return {
    active: counted.filter((r) => r.state.status === "active").length,
    total: counted.length,
    budget: rows.reduce((s, r) => s + (r.state.status === "active" ? r.state.monthly_budget : 0), 0),
    /* Once per channel: Google Business Profile and Search Console share google-organic,
       and adding both would count that spend twice. */
    spent: [...new Map(rows.filter((r) => r.channel).map((r) => [r.channel!, r.spentThisMonth ?? 0])).values()]
      .reduce((s, v) => s + v, 0),
    overBudget: rows.filter((r) => r.state.monthly_budget > 0 && (r.spentThisMonth ?? 0) > r.state.monthly_budget),
  };
}
