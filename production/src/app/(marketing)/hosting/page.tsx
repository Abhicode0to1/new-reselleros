import type { Metadata } from "next";
import { HostingLanding } from "@/site/components/hosting/HostingLanding";

/**
 * /hosting — the engine's landing page, brought into ResellerOS (merge brick
 * #5). Pardeep, 2 Sep 2026: the hosting landing on app.anutech.in is the one he
 * wants here, so this replaces the thinner marketing-site version that shipped
 * first. The component carries the design; this file only names the page.
 */
export const metadata: Metadata = {
  title: "Web hosting — 15-day free trial, powered by Google Cloud",
  description:
    "Enterprise-grade cPanel web hosting on Google Cloud. Free SSL, daily backups, free migration and 24×7 support. Start a 15-day free trial — no credit card required.",
};

export default function HostingPage() {
  return <HostingLanding />;
}
