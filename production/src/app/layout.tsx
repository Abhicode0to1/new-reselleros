import type { Metadata, Viewport } from "next";
import { SentryBoot } from "@/components/shared/sentry-boot";
import { DM_Serif_Display, Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";

import "@/app/globals.css";
import { cn } from "@/lib/utils";
import { Toaster } from "@/components/ui/toaster";
import { Providers } from "@/components/providers";

const fontSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const fontSerif = DM_Serif_Display({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-serif",
  display: "swap",
});

const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "ResellerOS — Reseller business, operated.",
    template: "%s · ResellerOS",
  },
  description:
    "The complete operating system for Indian cloud resellers. Sell Google Workspace, Microsoft 365, and Zoho with built-in GST invoicing, Razorpay payments, and Premier Partner escalation.",
  keywords: [
    "Google Workspace reseller",
    "cloud reseller SaaS India",
    "GST e-invoice",
    "Razorpay billing",
    "Premier Partner",
  ],
  authors: [{ name: "Excel Technologies Pvt Ltd" }],
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
  openGraph: {
    type: "website",
    locale: "en_IN",
    siteName: "ResellerOS",
  },
  // PWA / install-as-app
  applicationName: "ResellerOS",
  appleWebApp: {
    capable: true,
    title:   "ResellerOS",
    // iOS uses 'default', 'black', or 'black-translucent' for the status bar
    // 'default' keeps the warm cream paper feel after install.
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,  // don't auto-format Indian phone numbers as tappable nav
  },
};

export const viewport: Viewport = {
  themeColor: "#C2410C", // brand amber — used by Android Chrome toolbar tint + iOS splash
  width:      "device-width",
  initialScale: 1,
  // Prevent iOS Safari from zooming when focusing inputs (annoying on phone)
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={cn(
          "min-h-screen bg-paper text-ink antialiased",
          fontSans.variable,
          fontSerif.variable,
          fontMono.variable
        )}
      >
        {/* Browser Sentry init. The DSN is read HERE, at request time, because this is a
            Server Component — NEXT_PUBLIC_* would be inlined at build time and the value
            is a Cloud Run runtime variable. Getting that wrong is what the browser test
            page caught: dsnPresent false, an event id minted, nothing sent. */}
        <SentryBoot dsn={process.env.SENTRY_DSN?.trim() || null} />
        <Providers>{children}</Providers>
        <Toaster />
      </body>
    </html>
  );
}
