import Link from "@/site/components/ui/SiteLink";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DomainSearchDock } from "@/site/components/home/DomainSearchDock";
import Image from "next/image";
import { OfferBand } from "@/site/components/offers/OfferBand";
import { Reveal, SectionHead, ImageSlot } from "@/site/components/ui/bits";
import { CATALOGUE, CASES, REVIEWS, PROOF_POINTS } from "@/site/lib/data/copy";
import { COMPANY, SITE_URL } from "@/site/lib/config";

export const metadata: Metadata = {
  /* Absolute — the title IS the brand statement, so it must not also pick up the
     "· Anutech Digital" suffix the marketing template adds to every other page.
     It names the company AND everything the page sells, so a searcher (or an AI
     summarising the page) sees the full scope, not just the licence business. */
  title: {
    absolute: "Anutech Digital — Google Workspace, Microsoft 365, Zoho, Domains, Hosting & Email in India",
  },
  description:
    "Anutech Digital is a Delhi-based Google Premier Partner (since 2014). Buy Google Workspace, Microsoft 365 and Zoho licences, domains, cPanel hosting and business email in rupees — published prices, GST invoices, free migration and WhatsApp support.",
  keywords: [
    "Anutech Digital",
    "Google Workspace India price",
    "Microsoft 365 reseller India",
    "Zoho Workplace India",
    "buy domain India rupees",
    "cPanel hosting India",
    "business email India",
    "Google Premier Partner Delhi",
    "GST invoice cloud licences",
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

/* Each vendor's own brand colour, used ONLY on that vendor's name in the
   headline, so a reader recognises the three products at a glance. */
const MICROSOFT_BLUE = "#0078D4";
const ZOHO_RED       = "#E42527";

/* "Google" as Google sets it — the four brand colours, letter by letter
   (Pardeep supplied the logotype, 2 Sep 2026). "Workspace" stays in the
   headline's own ink, exactly as the real lockup does. */
const GOOGLE_LETTERS = [
  ["G", "#4285F4"], ["o", "#EA4335"], ["o", "#FBBC05"],
  ["g", "#4285F4"], ["l", "#34A853"], ["e", "#EA4335"],
] as const;

function GoogleWorkspace() {
  return (
    /* One accessible string for screen readers and for copy-paste; the coloured
       letters are decorative spans inside it. */
    <span aria-label="Google Workspace">
      <span aria-hidden>
        {GOOGLE_LETTERS.map(([ch, colour], i) => (
          <span key={i} style={{ color: colour }}>{ch}</span>
        ))}
        {" Workspace"}
      </span>
    </span>
  );
}

/**
 * Home — the public face of anutech.in (merge brick #5). The core IA decision
 * (handoff, first page): two audiences that must never be mixed — businesses
 * BUYING licences, and resellers who need SOFTWARE. Hence the explicit two-path
 * split under the hero, with the resell card in ResellerOS orange.
 *
 * A signed-in operator hitting `/` is sent straight to their workspace (the old
 * app landing did this too); `?preview=1` keeps them on the marketing page.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: { preview?: string };
}) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user && searchParams.preview !== "1") redirect("/dashboard");

  /* ── Structured data (SEO + AI answerability) ──────────────────────────────
     A single @graph an engine — or an LLM building an answer — can read to learn
     WHO Anutech Digital is, WHAT it sells and FOR HOW MUCH, without parsing the
     visual page. Prices come from the same CATALOGUE the cards render, so the
     graph can never disagree with what a visitor sees. */
  const priceNum = (s: string): number => {
    const m = s.match(/₹\s?([\d,]+)/);
    return m ? Number(m[1].replace(/,/g, "")) : 0;
  };
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
        address: {
          "@type": "PostalAddress",
          addressLocality: "Rohini",
          addressRegion: "Delhi",
          addressCountry: "IN",
        },
        contactPoint: {
          "@type": "ContactPoint",
          contactType: "customer support",
          email: COMPANY.supportEmail,
          areaServed: "IN",
          availableLanguage: ["en", "hi"],
        },
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
      {
        "@type": "OfferCatalog",
        name: "Anutech Digital — products and services",
        url: SITE_URL,
        provider: { "@id": `${SITE_URL}/#organization` },
        itemListElement: CATALOGUE.map((c) => {
          const price = priceNum(c.from);
          return {
            "@type": "Offer",
            name: c.name,
            description: c.body,
            url: `${SITE_URL}${c.href}`,
            priceCurrency: "INR",
            price,
            priceSpecification: {
              "@type": "PriceSpecification",
              priceCurrency: "INR",
              minPrice: price,
              description: c.from,
            },
          };
        }),
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
      {/* September offer — header ke neeche pehli cheez, poori chaudai ka hara band
         (Pardeep: "home page par noticeable jagah"). Client component, taaki expiry
         visitor ki ghadi se ho — static page ka build-time date nahi. */}
      <OfferBand />
      {/* The domain search as a TOOL: docked under the header on every scroll
         position, so a visitor can check a name whenever the thought strikes
         (Pardeep, 2 Sep 2026). It replaced the hero's search card — with the bar
         always on screen, a second copy in the hero was the same tool twice. */}
      <DomainSearchDock />
      {/* ── Hero: copy left, the product itself right ───────────────────────
         The search card used to sit on the right; with the search now docked,
         the column shows what the customer is actually buying — mail on their
         own domain. */}
      <section className="section rise">
        <div className="wrap" style={{ display: "grid", gridTemplateColumns: "1.05fr .95fr", gap: 52, alignItems: "center" }} data-grid="hero">
          <div>
            <div className="eyebrow" style={{ color: "var(--primary)", marginBottom: 14 }}>
              GOOGLE PREMIER PARTNER · DELHI · SINCE 2014
            </div>
            {/* Each product wears its own brand colour — Google's four-colour
                logotype, Microsoft's blue, Zoho's red — so the line is scannable
                in one glance (Pardeep, 2 Sep 2026, with the logo to match). */}
            <h1 className="h1-page" style={{ marginBottom: 18, maxWidth: 620 }}>
              <GoogleWorkspace />,{" "}
              <span style={{ color: MICROSOFT_BLUE }}>Microsoft&nbsp;365</span> and{" "}
              <span style={{ color: ZOHO_RED }}>Zoho</span> — bought in rupees, supported on WhatsApp.
            </h1>
            <p className="body-lg" style={{ margin: "0 0 26px", maxWidth: 560 }}>
              Licences, domains, hosting and business email for Indian businesses. Published prices,
              GST invoices, free migration — and a reply inside eleven minutes, not a ticket number.
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 26 }}>
              <Link href="/email/compare-editions" className="btn btn-primary">Compare editions &amp; prices</Link>
              <Link href="/quote" className="btn btn-outline">Get a quote for my headcount</Link>
            </div>
            {/* One flowing row rather than a 2×2 grid: at this width the grid
                broke "renewal shown up front" across lines and left ragged gaps.
                Flex-wrap keeps each promise on one line. */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 24px", marginBottom: 22 }}>
              {PROOF_POINTS.map((p) => (
                <span key={p} style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 14, color: "var(--text-secondary)" }}>
                  <span aria-hidden style={{ color: "var(--success)", fontWeight: 700 }}>✓</span> {p}
                </span>
              ))}
            </div>
            {/* The badge slot here was an empty dashed box — on a live page that
                reads as unfinished, not as "image coming". The credential is a
                sentence, so it is set as one. */}
            <p className="meta" style={{ margin: 0, maxWidth: 560, borderLeft: "2px solid var(--border-strong)", paddingLeft: 14 }}>
              The Google Premier Partner badge is earned yearly on certified staff and managed seats —
              it is Google&apos;s own tier, not a self-description.
            </p>
          </div>
          {/* The product itself, supplied by Pardeep (2 Sep 2026) — a real
              Workspace inbox, not a drawing. It replaced the search card that
              used to sit here (the search now lives in the dock above), so the
              column shows what the buyer is actually paying for. The caption is
              not decoration: a screenshot with no label makes the reader work
              out what they are looking at. */}
          <figure style={{ margin: 0 }}>
            <Image
              src="/googleworkspace-inbox.png"
              alt="A Google Workspace inbox: Gmail with the company's own labels, plus Chat, Meet and Spaces in the side rail"
              width={1024}
              height={640}
              priority
              sizes="(max-width: 979px) 100vw, 46vw"
              style={{
                width: "100%",
                height: "auto",
                border: "1px solid var(--border)",
                borderRadius: 10,
                boxShadow: "var(--shadow-panel)",
                display: "block",
              }}
            />
            <figcaption className="meta" style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: "4px 10px", alignItems: "baseline" }}>
              <span>Business email on your own domain —</span>
              <span className="mono" style={{ color: "var(--text)" }}>you@yourcompany.in</span>
              <span>· Gmail, Drive, Meet and Calendar included.</span>
            </figcaption>
          </figure>
        </div>
      </section>

      {/* ── Two-path split: buy vs resell ──────────────────────────────────── */}
      <section className="section-tight">
        <div className="wrap grid-2">
          <Reveal>
            <div className="card" style={{ height: "100%" }}>
              <div className="mono-label" style={{ color: "var(--primary)", marginBottom: 10 }}>I NEED THIS FOR MY BUSINESS</div>
              <h2 className="h2-sub" style={{ marginBottom: 10 }}>Buy licences, hosting and domains</h2>
              <p className="body" style={{ margin: "0 0 18px" }}>
                Google Workspace, Microsoft 365, Zoho, domains and hosting — bought in rupees with a GST
                invoice, set up by us.
              </p>
              <Link href="/email" className="btn btn-primary">See the catalogue</Link>
            </div>
          </Reveal>
          <Reveal>
            <div className="card card-highlight-os" style={{ height: "100%" }}>
              <div className="mono-label" style={{ color: "var(--accent)", marginBottom: 10 }}>I RESELL THIS FOR A LIVING</div>
              <h2 className="h2-sub" style={{ marginBottom: 10 }}>Manage your subscription business on ResellerOS</h2>
              <p className="body" style={{ margin: "0 0 18px" }}>
                Our own software: subscriptions and seats, GST quotes and invoices, renewals, bank
                reconciliation. Free during beta.
              </p>
              <Link href="/reselleros" className="btn btn-os">Explore ResellerOS →</Link>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Catalogue: six service cards on tint ───────────────────────────── */}
      <section className="section" style={{ background: "var(--tint)" }}>
        <div className="wrap">
          <SectionHead
            eyebrow="EVERYTHING WE SELL"
            title="The catalogue, with the price on the card"
            body="Every price is published, and the renewal price sits next to the first-year price — on this site, not inside a panel."
          />
          <div className="grid-3">
            {CATALOGUE.map((c) => (
              <Reveal key={c.name}>
                <Link href={c.href as never} className="card" style={{ display: "block", height: "100%" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                    <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>{c.name}</span>
                    <span className="mono" style={{ fontSize: 13, color: "var(--primary)" }}>{c.from}</span>
                  </div>
                  <p className="body" style={{ margin: "0 0 14px" }}>{c.body}</p>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {c.chips.map((chip) => (
                      <span key={chip} className="mono-label" style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "3px 7px", color: "var(--text-muted)" }}>
                        {chip}
                      </span>
                    ))}
                  </div>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Case studies ───────────────────────────────────────────────────── */}
      <section className="section">
        <div className="wrap">
          <SectionHead
            eyebrow="WORK WE POINT AT"
            title="Three migrations, told plainly"
            body="Client names and figures are placeholders until the real case studies are signed off."
          />
          <div className="grid-3">
            {CASES.map((c) => (
              <Reveal key={c.tag}>
                <div className="card" style={{ height: "100%" }}>
                  <div className="mono-label" style={{ color: "var(--primary)", marginBottom: 10 }}>{c.tag}</div>
                  <h3 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 8 }}>{c.headline}</h3>
                  <p className="body" style={{ margin: "0 0 18px" }}>{c.body}</p>
                  <div style={{ display: "flex", gap: 28 }}>
                    {c.stats.map((s) => (
                      <div key={s.label}>
                        <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em" }}>{s.value}</div>
                        <div className="mono-label" style={{ color: "var(--text-muted)" }}>{s.label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Client logo row: six supplied-asset slots ──────────────────────── */}
      <section className="section-tight" style={{ borderTop: "1px solid var(--border-light)" }}>
        <div className="wrap">
          <div className="mono-label" style={{ color: "var(--text-muted)", textAlign: "center", marginBottom: 18 }}>
            TEAMS WE LOOK AFTER
          </div>
          <div className="logo-row" style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12 }}>
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <ImageSlot key={i} label={`CLIENT LOGO ${i}`} height={64} />
            ))}
          </div>
        </div>
      </section>

      {/* ── Review strip ───────────────────────────────────────────────────── */}
      <section className="section" style={{ background: "var(--tint)" }}>
        <div className="wrap grid-3">
          {REVIEWS.map((r) => (
            <Reveal key={r.name}>
              <div className="card" style={{ height: "100%" }}>
                <div aria-label={`${r.stars.split("★").length - 1} star review`} style={{ color: "var(--warning)", letterSpacing: 2, marginBottom: 10 }}>
                  {r.stars}
                </div>
                <p style={{ fontSize: 15, lineHeight: 1.55, margin: "0 0 14px" }}>&ldquo;{r.quote}&rdquo;</p>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{r.name}</div>
                <div className="meta">{r.role}</div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>
    </>
  );
}
