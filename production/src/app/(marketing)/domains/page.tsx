import type { Metadata } from "next";
import { DomainLanding } from "@/site/components/domains/DomainLanding";
import { TLDS } from "@/site/lib/data/catalog";
import { DOMAIN_FAQS } from "@/site/lib/data/domains-landing";

/**
 * /domains — the conversion redesign ("Domain hosting improvement strategy",
 * 3 Sep 2026). The page is <DomainLanding/>, a self-contained editorial body;
 * the shared site chrome (home menu, utility bar, footer, cart drawer) wraps it
 * via the (marketing) layout, so navigation is present on this page as on every
 * other.
 *
 * SEO + AI-answerability (Pardeep's standing ask — the site should be legible to
 * Google/Gemini so it can rank and be quoted): rich <metadata> plus JSON-LD for
 * the organisation, the domain-registration offer catalogue (real ₹ prices from
 * TLDS), and the FAQ (the same six Q&A the page renders). All figures come from
 * the app's own data, never invented.
 */

const SITE_URL = "https://resellersos-njvk4nxhdq-el.a.run.app";

export const metadata: Metadata = {
  title: "Domain registration & transfer — the domain is ₹0 with yearly hosting",
  description:
    "Register or transfer a domain in rupees, with the renewal price printed next to the first-year price. The domain is ₹0 when it points at Anutech hosting on a yearly plan. 500+ extensions, GST invoice on every order.",
  alternates: { canonical: `${SITE_URL}/domains` },
  openGraph: {
    title: "Domain registration & transfer — ₹0 with yearly hosting",
    description:
      "The domain is ₹0 when it points at our hosting (yearly plan). Live registry lookup, renewal price shown up front, GST invoice on every order.",
    url: `${SITE_URL}/domains`,
    type: "website",
  },
};

/* Static-ish; the live availability check runs client-side, prices refresh on deploy. */
export const revalidate = 600;

export default function DomainsPage() {
  const cheapest = Math.min(...TLDS.map((t) => t.reg));

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        name: "Anutech Digital Pvt Ltd",
        url: SITE_URL,
        description: "Indian domain, hosting and business-email provider. Maker of ResellerOS.",
        address: { "@type": "PostalAddress", addressLocality: "Rohini", addressRegion: "Delhi", addressCountry: "IN" },
      },
      {
        "@type": "Product",
        name: "Domain registration",
        description:
          "Register or transfer a domain in rupees. The domain is ₹0 when bundled with a yearly Anutech hosting plan. Renewal price shown up front; GST invoice on every order.",
        brand: { "@type": "Brand", name: "Anutech Digital" },
        offers: {
          "@type": "AggregateOffer",
          priceCurrency: "INR",
          lowPrice: 0,
          highPrice: Math.max(...TLDS.map((t) => t.reg)),
          offerCount: TLDS.length,
          offers: TLDS.map((t) => ({
            "@type": "Offer",
            name: `${t.tld} domain — first year`,
            priceCurrency: "INR",
            price: t.reg,
            description: `${t.tld} for ${t.use}. Renews ₹${t.renew}/yr. ₹0 with a yearly hosting plan.`,
            url: `${SITE_URL}/domains#rates`,
          })),
        },
      },
      {
        "@type": "FAQPage",
        mainEntity: DOMAIN_FAQS.map((f) => ({
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
      <DomainLanding />
      <span hidden>{`Domains from ₹${cheapest}, ₹0 with yearly hosting.`}</span>
    </>
  );
}
