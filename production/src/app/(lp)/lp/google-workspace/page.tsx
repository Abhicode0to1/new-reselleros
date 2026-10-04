import type { Metadata } from "next";
import { WorkspaceAdLanding } from "@/site/components/lp/WorkspaceAdLanding";
import { fetchLiveWorkspace, mergeEditions } from "@/site/lib/live-catalog";

/**
 * /lp/google-workspace — the Google Ads landing page for Google Workspace (R-139, 4 Oct 2026).
 * Lives in the (lp) group: its own small header, no site menu (see (lp)/layout.tsx). noindex.
 * The price is the live catalogue's Business Starter yearly rate — the same figure checkout
 * charges (falls back to LICENCE_EDITIONS if the catalogue is down).
 */
export const metadata: Metadata = {
  title: "Google Workspace for Business",
  description: "Google Workspace for business by ANUTECH Digital — professional email, cloud storage, meetings and productivity tools. 14-day free trial, GST invoice, setup included.",
};

export const revalidate = 600;

export default async function GoogleWorkspaceLandingPage() {
  const editions = mergeEditions(await fetchLiveWorkspace());
  const starter = editions.find((e) => e.name === "GW Business Starter") ?? editions[0];
  return <WorkspaceAdLanding annualPerSeatMo={starter.annual} />;
}
