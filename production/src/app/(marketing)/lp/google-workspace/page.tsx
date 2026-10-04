import type { Metadata } from "next";
import { WorkspaceAdLanding } from "@/site/components/lp/WorkspaceAdLanding";
import { fetchLiveWorkspace, mergeEditions } from "@/site/lib/live-catalog";

/**
 * /lp/google-workspace — the Google Ads landing page for Google Workspace (R-139, 4 Oct 2026).
 * Not for search: noindex, so it never competes with /email for organic traffic, and ad
 * variants can come and go. The price is the live catalogue's Business Starter rate — the
 * same figure the checkout charges (falls back to LICENCE_EDITIONS if the catalogue is down).
 */
export const metadata: Metadata = {
  title: "Google Workspace — Business email from ₹136/user",
  description: "Google Workspace (Gmail on your domain, Drive, Meet, Docs) from an authorised Google partner in India. 14-day free trial, GST invoice, setup included.",
  robots: { index: false, follow: false },
};

export const revalidate = 600;

export default async function GoogleWorkspaceLandingPage() {
  const editions = mergeEditions(await fetchLiveWorkspace());
  const starter = editions.find((e) => e.name === "GW Business Starter") ?? editions[0];
  return (
    <WorkspaceAdLanding
      annualPerSeatMo={starter.annual}
      monthlyPerSeatMo={starter.monthlyOrNull ?? null}
    />
  );
}
