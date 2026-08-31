import Link from "next/link";
import type { Metadata } from "next";
import { DomainSearch } from "@/components/home/DomainSearch";
import { Reveal, SectionHead, ImageSlot } from "@/components/ui/bits";
import { CATALOGUE, CASES, REVIEWS, PROOF_POINTS } from "@/lib/data/copy";

export const metadata: Metadata = {
  title: "Anutech Digital — Google Workspace, M365 and Zoho in rupees",
};

/**
 * Home. The core IA decision (handoff, first page): two audiences that must never be
 * mixed — businesses BUYING licences, and resellers who need SOFTWARE. Hence the explicit
 * two-path split right under the hero, with the resell card in ResellerOS orange.
 */
export default function HomePage() {
  return (
    <>
      {/* ── Hero: 1.05fr .95fr, h1 54px, search card right ─────────────────── */}
      <section className="section rise">
        <div className="wrap" style={{ display: "grid", gridTemplateColumns: "1.05fr .95fr", gap: 48, alignItems: "start" }} data-grid="hero">
          <div>
            <div className="eyebrow" style={{ color: "var(--primary)", marginBottom: 14 }}>
              GOOGLE PREMIER PARTNER · DELHI · SINCE 2014
            </div>
            <h1 className="h1-hero" style={{ marginBottom: 18 }}>
              Google Workspace, Microsoft 365 and Zoho — bought in rupees, supported on WhatsApp.
            </h1>
            <p className="body-lg" style={{ margin: "0 0 26px", maxWidth: 520 }}>
              Licences, domains, hosting and business email for Indian businesses. Published prices,
              GST invoices, free migration — and a reply inside eleven minutes, not a ticket number.
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 30 }}>
              <Link href="/email/compare-editions" className="btn btn-primary">Compare editions &amp; prices</Link>
              <Link href="/quote" className="btn btn-outline">Get a quote for my headcount</Link>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 22px", maxWidth: 520 }}>
              {PROOF_POINTS.map((p) => (
                <div key={p} style={{ display: "flex", gap: 8, fontSize: 14, color: "var(--text-secondary)" }}>
                  <span aria-hidden style={{ color: "var(--success)", fontWeight: 700 }}>✓</span> {p}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 16, alignItems: "center", marginTop: 28, maxWidth: 460 }}>
              <div style={{ width: 120, flex: "none" }}>
                <ImageSlot label="PARTNER BADGE" height={74} />
              </div>
              <p className="meta" style={{ margin: 0 }}>
                The Google Premier Partner badge is earned yearly on certified staff and managed seats —
                it is Google&apos;s own tier, not a self-description.
              </p>
            </div>
          </div>
          <DomainSearch />
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
