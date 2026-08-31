import type { Metadata } from "next";
import { SectionHead, Reveal } from "@/components/ui/bits";
import { CASES, TRUST, COMPANY_FACTS } from "@/lib/data/copy";

export const metadata: Metadata = { title: "About Anutech Digital" };

export default function AboutPage() {
  return (
    <>
      <section className="section rise">
        <div className="wrap" style={{ display: "grid", gridTemplateColumns: "1.1fr .9fr", gap: 48 }} data-grid>
          <div>
            <h1 className="h1-page" style={{ marginBottom: 18 }}>
              A reseller since 2014, a software maker since 2026.
            </h1>
            <p className="body-lg" style={{ margin: "0 0 16px" }}>
              Anutech Digital Pvt Ltd sells and supports Google Workspace, Microsoft 365 and Zoho for
              Indian businesses — in rupees, on GST invoices, with migration done by us. Google has
              recognised the practice as a Premier Partner since 2014.
            </p>
            <p className="body-lg" style={{ margin: 0 }}>
              Twelve years of running that business produced ResellerOS, our own subscription-management
              software — and Anutech Digital is still its first customer. If a feature does not work for
              us in production, it does not ship.
            </p>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignContent: "start" }}>
            {TRUST.map((t) => (
              <div key={t.label} className="card" style={{ padding: 18 }}>
                <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.03em", color: "primary" in t && t.primary ? "var(--primary)" : "var(--text)" }}>
                  {t.value}
                </div>
                <div className="mono-label" style={{ color: "var(--text-muted)" }}>{t.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section-tight" style={{ background: "var(--tint)" }}>
        <div className="wrap">
          <SectionHead eyebrow="ON THE RECORD" title="Company facts" />
          <div className="grid-4" style={{ gap: 1, background: "var(--border)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
            {COMPANY_FACTS.map((f) => (
              <div key={f.label} style={{ background: "#fff", padding: 18 }}>
                <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 4 }}>{f.label}</div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{f.value}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <SectionHead eyebrow="WORK WE POINT AT" title="Three engagements, told plainly" />
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
    </>
  );
}
