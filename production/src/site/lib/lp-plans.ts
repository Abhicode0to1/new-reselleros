/**
 * One Google Ads landing page per Google Workspace plan (Pardeep, 4 Oct 2026: "google
 * workspace ke har product ka ek ek page banao"). Facts per plan (storage, Meet size,
 * what is included) live here; prices come from the live catalogue at request time.
 *
 * Only Business Starter carries the first-year offer — it is the only plan with a known
 * lower new-account cost (lib/workspace-offer.ts). The others lead with free setup,
 * migration and the 14-day trial, never an invented discount. Base is not here: resellers
 * cannot sell it.
 */
import type { WorkspaceAdCopy } from "@/site/components/lp/WorkspaceAdLanding";

export type LpPlanKey = "starter" | "standard" | "plus" | "enterprise";

export interface LpPlan {
  key: LpPlanKey;
  /** "Business Starter" */
  name: string;
  /** Edition name in the website catalogue (null = no list price: talk to us). */
  edition: string | null;
  /** Whether the Starter first-year offer applies (30+ users, new account). */
  offer: boolean;
  storage: string;
  meetPeople: string;
  /** Four benefits beside the price card. */
  benefits: readonly (readonly [string, string])[];
  /** Lines under the price on the price card. */
  includes: readonly string[];
  usersLimit: string;
  copy: WorkspaceAdCopy;
  /** Landing path (variant 1) and its page title in the app's list. */
  path: string;
  /** The all-plans category page: leads say "google-workspace", not one plan. */
  category?: boolean;
}

const COMMON_EYEBROW = "Authorised Google Workspace Reseller";

export const LP_PLANS: Record<LpPlanKey, LpPlan> = {
  starter: {
    key: "starter", name: "Business Starter", edition: "GW Business Starter", offer: true,
    storage: "30 GB per user", meetPeople: "Up to 100 people",
    benefits: [
      ["Professional email", "you@yourcompany.com — apne domain par"],
      ["Secure & reliable", "Google ki business-grade security"],
      ["Easy collaboration", "Kahin se bhi saath kaam karein"],
      ["Har device par", "Desktop, mobile aur tablet"],
    ],
    includes: ["30 GB per user · custom email", "Setup, domain aur migration help included"],
    usersLimit: "1 se 300 users tak",
    copy: {
      eyebrow: COMMON_EYEBROW,
      h1Rest: "Workspace for Your Business",
      h2: "Business ko banaye Smart, Secure & Professional!",
      sub: "Gmail, Drive, Meet, Docs aur bahut kuch — sab ek hi platform par. Work smarter, collaborate better, grow faster.",
    },
    path: "/lp/google-workspace-business-starter-1",
  },
  standard: {
    key: "standard", name: "Business Standard", edition: "GW Business Standard", offer: false,
    storage: "2 TB per user", meetPeople: "Up to 150 people + recordings",
    benefits: [
      ["2 TB per user", "Files, videos aur backups — jagah ki chinta nahi"],
      ["Meeting recordings", "150 log tak, recording seedha Drive mein"],
      ["Gemini AI", "Gmail, Docs, Sheets aur Meet mein AI madad"],
      ["Booking & eSignature", "Appointment pages aur Docs mein sign"],
    ],
    includes: ["2 TB per user · custom email", "Meet recordings · Gemini in Docs, Sheets, Meet", "Setup, domain aur migration help included"],
    usersLimit: "1 se 300 users tak",
    copy: {
      eyebrow: COMMON_EYEBROW,
      h1Rest: "Workspace Business Standard",
      h2: "Badhti team ke liye — 2 TB storage, recordings aur Gemini AI",
      sub: "Business email, 2 TB per user, 150 logon ki meetings recording ke saath, aur Docs, Sheets, Meet mein Gemini — setup aur migration hamari taraf se.",
    },
    path: "/lp/google-workspace-business-standard-1",
  },
  plus: {
    key: "plus", name: "Business Plus", edition: "GW Business Plus", offer: false,
    storage: "5 TB per user", meetPeople: "Up to 500 people",
    benefits: [
      ["5 TB per user", "Bade files aur archives ke liye"],
      ["Vault", "Mail aur files ka retention aur eDiscovery"],
      ["Advanced security", "Advanced endpoint management"],
      ["500-person meetings", "Bade townhalls aur trainings"],
    ],
    includes: ["5 TB per user · custom email", "Vault: retention & eDiscovery · advanced endpoint management", "Setup, domain aur migration help included"],
    usersLimit: "1 se 300 users tak",
    copy: {
      eyebrow: COMMON_EYEBROW,
      h1Rest: "Workspace Business Plus",
      h2: "Compliance aur security chahiye? Vault, 5 TB aur advanced controls",
      sub: "Mail aur files ka retention (Vault), 5 TB per user, 500 logon ki meetings aur advanced device security — sab Google Workspace mein, setup ANUTECH ka.",
    },
    path: "/lp/google-workspace-business-plus-1",
  },
  enterprise: {
    key: "enterprise", name: "Enterprise", edition: null, offer: false,
    storage: "5 TB per user, more on request", meetPeople: "Up to 1,000 people",
    benefits: [
      ["Enterprise security", "Data protection aur enterprise endpoint controls"],
      ["1,000-person meetings", "In-domain live streaming"],
      ["5 TB+ per user", "Zaroorat ho to aur storage"],
      ["No user limit", "300 se zyada users bhi"],
    ],
    includes: ["5 TB+ per user · custom email", "Enterprise security, Vault, 1,000-person meetings", "Migration planning aur rollout ANUTECH karta hai"],
    usersLimit: "koi limit nahi — 300 se zyada bhi",
    copy: {
      eyebrow: COMMON_EYEBROW,
      h1Rest: "Workspace Enterprise",
      h2: "Badi companies ke liye — enterprise security, bina user limit",
      sub: "300+ users, sakht security aur compliance, 1,000 logon ki meetings — hum aapki zaroorat samajh kar Enterprise ka quote aur rollout plan dete hain.",
    },
    path: "/lp/google-workspace-enterprise-1",
  },
};

/** Free Gmail vs this plan — facts only. */
export function compareRows(plan: LpPlan): [string, string, string][] {
  return [
    ["Email address", "yourname@gmail.com", "you@yourcompany.com"],
    ["Storage", "15 GB, shared with Drive & Photos", plan.storage],
    ["Ads in the inbox", "Yes", "No ads"],
    ["Group video calls", "60-minute limit", `${plan.meetPeople}, long meetings`],
    ["Who owns the account", "The employee", "Your company — add, remove, reset any user"],
    ["Help when stuck", "Online forums", "ANUTECH team + Google support"],
  ];
}

/**
 * The Google Workspace category page (R-154, 5 Oct 2026): broad "google workspace" ads land
 * here. It leads with the Starter offer (the plan most small businesses buy) and lists every
 * plan below, so it borrows Starter's facts for the price card and its own copy for the hero.
 */
export const LP_CATEGORY: LpPlan = {
  ...LP_PLANS.starter,
  category: true,
  copy: {
    eyebrow: COMMON_EYEBROW,
    h1Rest: "Workspace — har business ke liye plan",
    h2: "Starter se Enterprise tak — sahi plan, sahi daam, setup hamari taraf se",
    sub: "Gmail, Drive, Meet, Docs aur Gemini — 1 user se 1,000+ tak. Plan hum milkar chunte hain; domain, users aur purana mail hamari team shift karti hai.",
  },
  path: "/lp/google-workspace-1",
};

/** Plan order on the category page. */
export const LP_PLAN_ORDER: readonly LpPlanKey[] = ["starter", "standard", "plus", "enterprise"];
