import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { HomeV2 } from "@/site/components/home/HomeV2";
import { HOME_FAQS } from "@/site/lib/data/home-faqs";
import { COMPANY, SITE_URL } from "@/site/lib/config";
import { LICENCE_EDITIONS } from "@/site/lib/data/catalog";

/**
 * Home — the email-first "Anutech Home v2" (5 Sep 2026). The body is <HomeV2/>
 * (suite → edition → Buy/Trial/Quote); the shared chrome wraps it.
 *
 * A signed-in operator hitting "/" is sent to their workspace; "?preview=1"
 * keeps them on the marketing page (the logo links there so it never bounces).
 *
 * SEO + AI answer-ability (per the 5 Sep web research): the JSON-LD @graph now
 * also carries a Product + AggregateOffer per suite with real ₹ prices, and a
 * FAQPage matching the on-page FAQ — the markup an engine or an LLM reads to
 * quote what Anutech sells and for how much. Every figure comes from
 * LICENCE_EDITIONS, never invented.
 */

export const metadata: Metadata = {
  title: {
    absolute: "Anutech Digital — Google Workspace, Microsoft 365, Zoho, Domains, Hosting & Email in India",
  },
  description:
    "Anutech Digital is a Delhi-based Google Premier Partner (since 2014). Buy Google Workspace, Microsoft 365 and Zoho licences, domains, cPanel hosting and business email in rupees — published prices, GST invoices, free migration and WhatsApp support.",
  keywords: [
    "Anutech Digital",
    "Google Workspace price India",
    "Microsoft 365 reseller India",
    "Zoho Workplace India",
    "business email India GST invoice",
    "buy domain India rupees",
    "cPanel hosting India",
    "Google Premier Partner Delhi",
  ],
  alternates: { canonical: `${SITE_URL}/` },
  openGraph: {
    title: "Anutech Digital — Google Workspace, Microsoft 365, Zoho, Domains & Hosting",
    description:
      "Google Premier Partner in Delhi since 2014. Licences, domains, hosting and business email in rupees — published prices, GST invoices, free migration, WhatsApp support.",
    url: `${SITE_URL}/`,
    siteName: "Anutech Digital",
    type: "website",
    locale: "en_IN",
  },
};

/** Suite → its editions, for the Product/Offer structured data. */
const SUITES: { name: string; prefix: string; desc: string }[] = [
  { name: "Google Workspace", prefix: "GW ", desc: "Gmail, Meet, Drive and Docs on your own domain, billed in rupees with a GST invoice." },
  { name: "Microsoft 365", prefix: "M365 ", desc: "Outlook, Teams and OneDrive for your team, billed in rupees with a GST invoice." },
  { name: "Zoho Workplace", prefix: "Zoho", desc: "Mail plus Writer, Sheet and Show — the cheapest full suite, billed in rupees." },
];

export default async function HomePage({
  searchParams,
}: {
  searchParams: { preview?: string };
}) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user && searchParams.preview !== "1") redirect("/dashboard");

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${SITE_URL}/#organization`,
        name: COMPANY.name,
        alternateName: COMPANY.short,
        url: SITE_URL,
        logo: `${SITE_URL}/anutech-digital-logo.png`,
        description:
          "Delhi-based Google Premier Partner (since 2014) selling Google Workspace, Microsoft 365 and Zoho licences, domains, cPanel hosting and business email to Indian businesses, in rupees with GST invoices. Maker of ResellerOS.",
        foundingDate: "2014",
        award: "Google Premier Partner",
        taxID: COMPANY.gstin,
        address: { "@type": "PostalAddress", addressLocality: "Rohini", addressRegion: "Delhi", addressCountry: "IN" },
        contactPoint: { "@type": "ContactPoint", contactType: "customer support", email: COMPANY.supportEmail, areaServed: "IN", availableLanguage: ["en", "hi"] },
        areaServed: "IN",
      },
      {
        "@type": "WebSite",
        "@id": `${SITE_URL}/#website`,
        name: "Anutech Digital",
        url: SITE_URL,
        publisher: { "@id": `${SITE_URL}/#organization` },
        inLanguage: "en-IN",
      },
      // One Product per suite, with an AggregateOffer over its real editions.
      ...SUITES.map((s) => {
        const eds = LICENCE_EDITIONS.filter((e) => e.name.startsWith(s.prefix));
        const prices = eds.map((e) => e.annual);
        return {
          "@type": "Product",
          name: s.name,
          description: s.desc,
          brand: { "@type": "Brand", name: s.name },
          category: "Business email and productivity suite",
          offers: {
            "@type": "AggregateOffer",
            priceCurrency: "INR",
            lowPrice: Math.min(...prices),
            highPrice: Math.max(...prices),
            offerCount: eds.length,
            offers: eds.map((e) => ({
              "@type": "Offer",
              name: `${e.name} — per user / month (annual, GST extra)`,
              priceCurrency: "INR",
              price: e.annual,
              url: `${SITE_URL}/#products`,
              seller: { "@id": `${SITE_URL}/#organization` },
            })),
          },
        };
      }),
      {
        "@type": "FAQPage",
        mainEntity: HOME_FAQS.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <HomeV2 />
    </>
  );
}
