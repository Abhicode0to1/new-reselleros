import type { Metadata } from "next";
import { HostingLanding } from "@/site/components/hosting/HostingLanding";
import { HOSTING_TIERS, HOSTING_FAQS_V2 } from "@/site/lib/data/hosting-landing-v2";

/**
 * /hosting — the conversion-focused hosting landing page (redesign, 2 Sep 2026).
 *
 * Deliberately in its OWN route group, NOT under (marketing): this is a single
 * focused funnel with its own announcement strip, sticky header, footer and
 * decision bar (all inside HostingLanding), so it must not inherit the marketing
 * site chrome — that would double the header and footer. The root layout gives
 * it only <body> + providers; the component carries the entire design and loads
 * its own fonts (Manrope / Instrument Serif / JetBrains Mono).
 *
 * SEO + AI-answer-engine friendliness (Pardeep, 2 Sep — "koi AI chatbot jaise
 * Gemini me ranking la sake"): rich metadata plus server-rendered JSON-LD for
 * Organization, the three priced Offers, and the FAQ. Answer engines (Gemini,
 * ChatGPT, Perplexity) and Google's rich results read this structured, factual
 * markup directly, and it is generated from the SAME real data the page shows,
 * so the machine-readable facts can never drift from the visible ones.
 */

const SITE_URL = "https://resellersos-njvk4nxhdq-el.a.run.app";
const PAGE_URL = `${SITE_URL}/hosting`;

export const metadata: Metadata = {
  title: "Web hosting on Google Cloud — 15-day free trial, no credit card | Anutech Digital",
  description:
    "cPanel web hosting on Google Cloud from Anutech Digital. Free SSL, daily backups, free migration and 24×7 support. Plans from ₹49.99/mo. Start a 15-day free trial — no credit card, GST invoice on every order.",
  keywords: [
    "web hosting India", "cPanel hosting", "Google Cloud hosting", "free website migration",
    "WordPress hosting India", "GST invoice hosting", "15-day free trial hosting", "Anutech Digital",
  ],
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    siteName: "Anutech Digital",
    title: "Web hosting on Google Cloud — 15-day free trial, no credit card",
    description:
      "cPanel web hosting on Google Cloud. Free SSL, daily backups, free migration, 24×7 support. Plans from ₹49.99/mo. 15-day free trial, no credit card.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Web hosting on Google Cloud — 15-day free trial",
    description: "cPanel hosting from Anutech Digital. Free migration, GST invoice, no-card trial.",
  },
};

/** JSON-LD built from the SAME real data the page renders — never a second copy. */
function structuredData() {
  const organization = {
    "@type": "Organization",
    name: "Anutech Digital Pvt Ltd",
    url: SITE_URL,
    address: {
      "@type": "PostalAddress",
      addressLocality: "Rohini",
      addressRegion: "Delhi",
      addressCountry: "IN",
    },
    taxID: "07ABDCA0298H1ZP",
    makesOffer: "Web hosting, domain registration and Google Workspace for Indian businesses",
  };

  const prices = HOSTING_TIERS.map((t) => t.yearlyTotal);
  const product = {
    "@type": "Product",
    name: "Web hosting on Google Cloud",
    description:
      "cPanel web hosting on Google Cloud with free SSL, automatic daily backups, free website migration and 24×7 support. Three plans: Starter, Standard and Plus.",
    brand: { "@type": "Brand", name: "Anutech Digital" },
    category: "Web hosting",
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: "INR",
      lowPrice: Math.min(...prices),
      highPrice: Math.max(...prices),
      offerCount: HOSTING_TIERS.length,
      offers: HOSTING_TIERS.map((t) => ({
        "@type": "Offer",
        name: `${t.name} hosting (billed yearly)`,
        priceCurrency: "INR",
        price: t.yearlyTotal,
        description: `${t.storage} NVMe SSD storage, ${t.bandwidth} bandwidth, ${t.sites === "1" ? "1 website" : "multiple websites"}. Renews at ${t.yearlyMo}/mo — the same price.`,
        availability: "https://schema.org/InStock",
        url: PAGE_URL,
      })),
    },
  };

  const faq = {
    "@type": "FAQPage",
    mainEntity: HOSTING_FAQS_V2.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  return { "@context": "https://schema.org", "@graph": [organization, product, faq] };
}

export default function HostingPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData()) }}
      />
      <HostingLanding />
    </>
  );
}
