import type { Metadata } from "next";
import { Suspense } from "react";
import { HostingTrialForm } from "@/site/components/hosting/HostingTrialForm";

/**
 * /hosting/trial — the customer's "start a hosting trial" form. Under (marketing)
 * so it keeps the site's home-page menu (Pardeep: the menu on every page). This
 * is where the /hosting "Start free trial" buttons lead — a customer flow, not
 * the reseller /signup. noindex: it's a form endpoint, not a page to rank; the
 * /hosting page is the one search + AI engines should surface.
 */
export const metadata: Metadata = {
  title: "Start your hosting trial — no credit card | Anutech Digital",
  description: "Start a 15-day free cPanel hosting trial on Google Cloud. No credit card. We set up the account and handle migration.",
  robots: { index: false, follow: true },
};

export default function HostingTrialPage() {
  return (
    <Suspense fallback={null}>
      <HostingTrialForm />
    </Suspense>
  );
}
