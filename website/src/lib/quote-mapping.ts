/**
 * Which vendor bucket a quote-form product falls into, for the app's enquiry API.
 *
 * The app's `/api/public/enquiry/general` accepts a product enum of
 * google-workspace | microsoft-365 | zoho | other. The website's quote form now offers
 * EDITION-level choices ("GW Business Standard", "M365 Business Basic", …) because a
 * quotation without the exact edition is not a quotation — Pardeep's words when he found
 * the form only knew "Google Workspace": "bina product ke quote kaise jayege".
 *
 * The edition name itself travels in `requirement` (free text the operator and the AI
 * agent read); this mapping only picks the enum bucket. Pure and tested, because a wrong
 * bucket files the lead under the wrong vendor.
 */
export type ApiProduct = "google-workspace" | "microsoft-365" | "zoho" | "other";

export function apiProductFor(name: string): ApiProduct {
  const n = name.toLowerCase();
  if (n.startsWith("gw ") || n.includes("google workspace")) return "google-workspace";
  if (n.startsWith("m365") || n.includes("microsoft 365")) return "microsoft-365";
  if (n.includes("zoho")) return "zoho";
  return "other";
}
