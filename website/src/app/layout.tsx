import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import { CartProvider } from "@/components/cart/CartProvider";
import { CartDrawer } from "@/components/cart/CartDrawer";
import { Header } from "@/components/chrome/Header";
import { UtilityBar, Breadcrumb, CtaBand, Footer, WhatsAppButton, ConsentBanner } from "@/components/chrome/Chrome";
import "./globals.css";

/* The handoff's two faces, and only these two: Archivo carries everything, IBM Plex Mono
   carries labels, prices, TLDs and document numbers. next/font self-hosts them, so the
   site does not call Google Fonts at runtime. */
const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Anutech Digital — Google Workspace, M365 and Zoho in rupees",
    template: "%s · Anutech Digital",
  },
  description:
    "Anutech Digital Pvt Ltd, Delhi. Google Premier Partner since 2014. Licences, domains, hosting and business email in ₹ with GST invoices — plus ResellerOS, our subscription-management software for Indian cloud resellers.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${plexMono.variable}`}>
      <body>
        <CartProvider>
          <a href="#main" className="skip-link">Skip to content</a>
          <UtilityBar />
          <Header />
          <Breadcrumb />
          <main id="main">{children}</main>
          <CtaBand />
          <Footer />
          <WhatsAppButton />
          <ConsentBanner />
          <CartDrawer />
        </CartProvider>
      </body>
    </html>
  );
}
