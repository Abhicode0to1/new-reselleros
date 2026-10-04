/**
 * Ad landing pages — the list the app shows under Marketing → Ads landing pages
 * (Pardeep, 4 Oct 2026: "ads landing pages ko bhi app me show karo").
 *
 * One row per page under src/app/(lp)/lp/. Add the row in the same change that adds a page
 * (the 3–4 Google Workspace variants are next), or the team cannot find, copy or check it.
 * Leads are matched by `leads.landing_page_url`, which stores the path + utm params only.
 */
export interface AdLandingPage {
  /** Path on the public site, e.g. "/lp/google-workspace". Leads are matched on it. */
  path: string;
  title: string;
  product: string;
  /** The offer the page leads with — what the ad copy must agree with. */
  offer: string;
  /** Where the visitor's request lands, for the person who answers it. */
  captures: string;
  addedOn: string; // ISO date
}

/** The public marketing domain the ads point at. */
export const PUBLIC_SITE_ORIGIN = "https://anutech.in";

export const AD_LANDING_PAGES: readonly AdLandingPage[] = [
  {
    path: "/lp/google-workspace",
    title: "Google Workspace — main ad page",
    product: "Google Workspace Business Starter",
    offer: "30+ users, new account: ₹1,650/user for the first year (49% off) + free setup and migration",
    captures: "Call-back form (name + mobile), Free trial / Buy enquiry, WhatsApp",
    addedOn: "2026-10-04",
  },
];

/** Final URL to paste into Google Ads. Auto-tagging adds the gclid; leads keep it. */
export function adFinalUrl(page: AdLandingPage): string {
  return PUBLIC_SITE_ORIGIN + page.path;
}
