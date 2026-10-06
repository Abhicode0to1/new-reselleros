import type { Metadata } from "next";
import { Archivo } from "next/font/google";

/**
 * Ad landing pages (R-139, 4 Oct 2026). Deliberately NOT the marketing layout: an ad visitor
 * gets one page with one job and its own small header, not the whole site menu, cart and chat
 * to wander off into. Pages here are noindex and Anutech-branded.
 */
const archivo = Archivo({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  title: { template: "%s · Anutech Digital", default: "Anutech Digital" },
  robots: { index: false, follow: false },
};

export default function LandingLayout({ children }: { children: React.ReactNode }) {
  return <div className={archivo.variable}>{children}</div>;
}
