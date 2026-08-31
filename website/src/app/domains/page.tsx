import type { Metadata } from "next";
import { DomainSearch } from "@/components/home/DomainSearch";
import { DomainRateCard } from "@/components/domains/DomainRateCard";
import { SectionHead, Reveal } from "@/components/ui/bits";
import { DOMAIN_FEATURES } from "@/lib/data/copy";
import { effectiveReg, DOMAIN_OFFERS } from "@/lib/offers";
import { TLDS } from "@/lib/data/catalog";

export const metadata: Metadata = { title: "Domain registration & transfer" };

export default function DomainsPage() {
  return (
    <>
      <section className="section rise">
        <div className="wrap" style={{ display: "grid", gridTemplateColumns: "1fr 640px", gap: 48, alignItems: "start" }} data-grid>
          <div>
            {/* Offer strip — render-time check, isliye 1 Oct ko khud gayab. Renewal usi
                saans me bola jata hai; offer positioning ko todta nahi, use nibhata hai. */}
            {(() => {
              const inTld = TLDS.find((t) => t.tld === ".in");
              const p = inTld ? effectiveReg(".in", inTld.reg) : null;
              return p?.offer && DOMAIN_OFFERS[".in"] ? (
                <div className="mono-label" style={{ display: "inline-block", marginBottom: 16, padding: "8px 14px", borderRadius: 999, background: "#EEF7F0", color: "var(--success)", border: "1px solid var(--success)" }}>
                  {p.offer.label} — .IN {"\u20B9"}1 FIRST YEAR (RENEWS {"\u20B9"}{inTld!.renew}/YR) · TILL 30 SEP
                </div>
              ) : null;
            })()}
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
