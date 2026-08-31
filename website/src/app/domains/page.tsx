import type { Metadata } from "next";
import { DomainSearch } from "@/components/home/DomainSearch";
import { DomainRateCard } from "@/components/domains/DomainRateCard";
import { SectionHead, Reveal } from "@/components/ui/bits";
import { DOMAIN_FEATURES } from "@/lib/data/copy";
import { OfferBand } from "@/components/offers/OfferBand";

export const metadata: Metadata = { title: "Domain registration & transfer" };

export default function DomainsPage() {
  return (
    <>
      <section className="section rise">
        <div className="wrap" style={{ display: "grid", gridTemplateColumns: "1fr 640px", gap: 48, alignItems: "start" }} data-grid>
          <div>
            {/* Client pill — server strip build-time date freeze kar deta (page static
               hai); browser me expiry visitor ki apni ghadi se hoti hai. */}
            <OfferBand variant="pill" />
            <h1 className="h1-page" style={{ marginBottom: 16 }}>
              Register, renew and transfer — every price on one row.
            </h1>
            <p className="body-lg" style={{ margin: 0, maxWidth: 480 }}>
              500+ extensions in rupees. The renewal price is printed next to the first-year price,
              because that is the number that actually decides what a domain costs.
            </p>
          </div>
          <DomainSearch />
        </div>
      </section>

      <section className="section-tight" id="rates" style={{ background: "var(--tint)" }}>
        <div className="wrap">
          <SectionHead
            eyebrow="RATE CARD"
            title="The rate card, in the open"
            body="Filter by what the name is for. Add puts a first-year registration in the cart."
          />
          <DomainRateCard />
        </div>
      </section>

      <section className="section" id="included">
        <div className="wrap">
          <SectionHead eyebrow="INCLUDED" title="Included with every domain" />
          <div className="grid-4" style={{ gap: 24 }}>
            {DOMAIN_FEATURES.map((f) => (
              <Reveal key={f.title}>
                <div style={{ borderTop: "2px solid var(--dark)", paddingTop: 14 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{f.title}</div>
                  <p className="body" style={{ margin: 0, fontSize: 14 }}>{f.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
