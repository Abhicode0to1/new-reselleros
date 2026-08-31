/**
 * Every external address in ONE place.
 *
 * The handoff hardcoded the ResellerOS links to the numeric ALIAS Cloud Run URL (the one
 * Scheduler calls), not the canonical service — and a third, dead service URL also exists.
 * The app's repo has already paid for scattered URLs once: six files carried the dead
 * service's address. So the base URL is written exactly once here, overridable per
 * environment — and site-invariants.test.ts fails if any other file carries a run.app URL,
 * the alias's number, or the dead service's number. (The numbers are deliberately not
 * written in this comment: that same test reads every file, including this one.)
 */
export const RESELLEROS_URL =
  process.env.NEXT_PUBLIC_RESELLEROS_URL?.trim() ||
  "https://resellersos-njvk4nxhdq-el.a.run.app";

export const OS_SIGNUP = `${RESELLEROS_URL}/signup`;

/**
 * The handoff's "Explore the interactive demo" pointed at `/dashboard?preview=1` — a route
 * that DOES NOT EXIST in the app (checked 31 Aug 2026: no preview handling anywhere under
 * src/app/(app)/dashboard). Until a real demo mode ships, the demo CTA goes to the login
 * page, which carries the dev demo list. Building a public preview mode is an app-side task.
 */
export const OS_DEMO = `${RESELLEROS_URL}/login`;

/** Where the website's quote form posts — the app's public lead-capture API. */
export const ENQUIRY_API = `${RESELLEROS_URL}/api/public/enquiry/general`;

/**
 * PLACEHOLDER — the handoff marks the phone number as fake on purpose
 * ("+91 98xxx xxxxx"). Replace with the real number before launch; the wa.me link is
 * built from it, so a fake number here means a dead WhatsApp button.
 */
export const WHATSAPP_NUMBER = "919800000000";
export const WHATSAPP_URL = `https://wa.me/${WHATSAPP_NUMBER}`;

export const COMPANY = {
  name: "Anutech Digital Pvt Ltd",
  short: "Anutech Digital",
  gstin: "07ABDCA0298H1ZP",
  hsn: "998313",
  city: "Rohini, Delhi",
  founder: "Pardeep Sharma",
  supportEmail: "support@anutech.in",
  partnerLine: "Google Premier Partner, since 2014",
  hours: "Mon–Sat, 10:00–19:00 IST",
} as const;
