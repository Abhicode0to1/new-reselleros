import type { Metadata } from "next";
import { OS_SIGNUP, OS_DEMO } from "@/site/lib/config";
import { SectionHead, Reveal, Tick, ImageSlot } from "@/site/components/ui/bits";
import {
  OS_KPIS, OS_QUOTES, OS_FACTS, OS_PAINS, OS_MODULES, OS_MORE, OS_ONBOARDING,
  OS_SECURITY, OS_INTEGRATIONS, OS_CHANGELOG, OS_TIERS, OS_WHY, OS_FOUNDER_QUOTE,
} from "@/site/lib/data/reselleros";

export const metadata: Metadata = {
  title: "ResellerOS — software for Indian cloud resellers",
  description:
    "Run a subscription business, not seven spreadsheets. Subscriptions, GST quotes and invoices, renewals and bank reconciliation for Google Workspace, M365 and Zoho resellers in India.",
};

/**
 * The ONE page wearing the product accent (#C2410C). Its two CTAs are the real integration:
 * they link to the live app (lib/config.ts — the handoff's alias URL corrected to the
 * canonical service). Everything else on this page is presentation.
 */
export default function ResellerOsPage() {
  return (
    <>
      {/* ── Hero with dashboard mock ───────────────────────────────────────── */}
      <section className="section rise">
        <div className="wrap" style={{ display: "grid", gridTemplateColumns: "1.05fr .95fr", gap: 48, alignItems: "center" }} data-grid>
          <div>
            <div className="eyebrow" style={{ color: "var(--accent)", background: "#FDF0E8", display: "inline-block", padding: "6px 12px", borderRadius: 999, marginBottom: 16 }}>
              RESELLEROS · BY ANUTECH DIGITAL · FREE DURING BETA
            </div>
            <h1 style={{ fontSize: 46, fontWeight: 700, letterSpacing: "-0.04em", lineHeight: 1.05, marginBottom: 18 }}>
              Run a subscription business, not seven spreadsheets.
            </h1>
            <p className="body-lg" style={{ margin: "0 0 26px", maxWidth: 500 }}>
              ResellerOS manages the whole subscription lifecycle — seats, commitment terms, GST quotes
              and invoices, renewals, banking and a customer portal — for Google Workspace, Microsoft 365
              and Zoho resellers in India.
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
              <a href={OS_SIGNUP} target="_blank" rel="noopener" className="btn btn-os">Start free trial</a>
              <a href={OS_DEMO} target="_blank" rel="noopener" className="btn btn-outline">Explore the interactive demo</a>
            </div>
            <p className="meta" style={{ margin: 0 }}>14-day trial · every module · no card, no seat limit</p>
          </div>

          <Reveal>
            <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", boxShadow: "var(--shadow-panel)" }}>
              <div style={{ background: "var(--dark)", color: "#9AA5B1", padding: "10px 16px", fontSize: 12 }} className="mono">
                resellersos.in/dashboard
              </div>
              <div style={{ padding: 20 }}>
                <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>Good morning, Pardeep.</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
                  {OS_KPIS.map((k) => (
                    <div key={k.label} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" }}>
                      <div className="mono-label" style={{ color: "var(--text-muted)" }}>{k.label}</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: k.accent ? "var(--accent)" : "var(--text)" }}>{k.value}</div>
                      <div className="meta" style={{ fontSize: 12 }}>{k.note}</div>
                    </div>
                  ))}
                </div>
                {OS_QUOTES.map((q) => (
                  <div key={q.no} style={{ display: "flex", gap: 10, fontSize: 13, padding: "7px 0", borderTop: "1px solid var(--border-hairline)" }}>
                    <span className="mono" style={{ color: "var(--text-muted)" }}>{q.no}</span>
                    <span style={{ flex: 1 }}>{q.who}</span>
                    <span style={{ fontWeight: 600 }}>{q.amount}</span>
                    <span className="mono-label" style={{ color: q.color }}>{q.status}</span>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Dark facts strip ───────────────────────────────────────────────── */}
      <section style={{ background: "var(--dark)", padding: "22px 0" }}>
        <div className="wrap" style={{ display: "flex", gap: 26, flexWrap: "wrap", justifyContent: "space-between" }}>
          {OS_FACTS.map((f) => (
            <span key={f} className="mono-label" style={{ color: "#9AA5B1" }}>{f}</span>
          ))}
        </div>
      </section>

      {/* ── Four problems ──────────────────────────────────────────────────── */}
      <section className="section">
        <div className="wrap">
          <SectionHead
            os
            eyebrow="THE SEVEN-APP PROBLEM"
            title="If this sounds familiar, ResellerOS was built from exactly these four problems"
          />
          <div className="grid-4" style={{ gap: 24 }}>
            {OS_PAINS.map((p) => (
              <Reveal key={p.title}>
                <div style={{ borderTop: "2px solid var(--accent)", paddingTop: 14 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{p.title}</div>
                  <p className="body" style={{ margin: 0, fontSize: 14 }}>{p.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Five modules ───────────────────────────────────────────────────── */}
      <section className="section" id="modules" style={{ background: "var(--tint)" }}>
        <div className="wrap" style={{ display: "flex", flexDirection: "column", gap: 44 }}>
          {OS_MODULES.map((m, i) => (
            <Reveal key={m.no}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, alignItems: "center", direction: i % 2 ? "rtl" : "ltr" }} data-grid>
                <div style={{ direction: "ltr" }}>
                  <div className="mono-label" style={{ color: "var(--accent)", marginBottom: 10 }}>{m.no}</div>
                  <h2 className="h2-sub" style={{ marginBottom: 10 }}>{m.title}</h2>
                  <p className="body" style={{ margin: "0 0 14px" }}>{m.body}</p>
                  {m.bullets.map((b) => (
                    <Tick key={b}>{b}</Tick>
                  ))}
                </div>
                <div style={{ direction: "ltr", background: "#fff", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                  <div className="mono" style={{ background: "var(--dark)", color: "#9AA5B1", padding: "8px 14px", fontSize: 12 }}>{m.mockTitle}</div>
                  <div style={{ padding: "6px 14px 10px" }}>
                    {m.rows.map((r) => (
                      <div key={r.a} style={{ display: "flex", gap: 10, fontSize: 13, padding: "8px 0", borderBottom: "1px solid var(--border-hairline)" }}>
                        <span style={{ flex: 1 }}>{r.a}</span>
                        <span style={{ fontWeight: 600 }}>{r.b}</span>
                        <span className="mono-label" style={{ color: r.color }}>{r.c}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── Screenshots + more modules ─────────────────────────────────────── */}
      <section className="section">
        <div className="wrap">
          <div className="grid-3" style={{ marginBottom: 44 }}>
            {["DASHBOARD SCREENSHOT", "QUOTE SCREENSHOT", "RENEWALS SCREENSHOT"].map((s) => (
              <ImageSlot key={s} label={s} height={200} />
            ))}
          </div>
          <SectionHead os eyebrow="AND THE REST" title="Twelve more modules, same database" />
          <div className="grid-4" style={{ gap: 1, background: "var(--border)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
            {OS_MORE.map((m) => (
              <div key={m.title} style={{ background: "#fff", padding: 18 }}>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>{m.title}</div>
                <div className="meta">{m.body}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Onboarding 01–04 ───────────────────────────────────────────────── */}
      <section className="section" style={{ background: "var(--tint)" }}>
        <div className="wrap">
          <SectionHead os eyebrow="GETTING IN" title="Four steps to your first GST invoice" />
          <div className="grid-4" style={{ gap: 24 }}>
            {OS_ONBOARDING.map((s) => (
              <Reveal key={s.step}>
                <div>
                  <div className="mono" style={{ fontSize: 24, color: "var(--accent)", fontWeight: 500, marginBottom: 8 }}>{s.step}</div>
                  <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{s.title}</div>
                  <p className="body" style={{ margin: 0, fontSize: 14 }}>{s.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Security + integrations + changelog ────────────────────────────── */}
      <section className="section">
        <div className="wrap">
          <SectionHead os eyebrow="TRUST" title="Security and compliance, stated plainly" />
          <div className="grid-3" style={{ marginBottom: 44 }}>
            {OS_SECURITY.map((s) => (
              <Reveal key={s.title}>
                <div style={{ borderTop: "2px solid var(--dark)", paddingTop: 14 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{s.title}</div>
                  <p className="body" style={{ margin: 0, fontSize: 14 }}>{s.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
          <div className="grid-4" style={{ gap: 12, marginBottom: 44 }}>
            {OS_INTEGRATIONS.map((i) => (
              <div key={i.name} className="card" style={{ padding: 16 }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{i.name}</div>
                <div className="meta">{i.note}</div>
              </div>
            ))}
          </div>
          <SectionHead os eyebrow="SHIPPING" title="Recent changelog" />
          <div style={{ maxWidth: 720 }}>
            {OS_CHANGELOG.map((c) => (
              <div key={c.date} style={{ display: "flex", gap: 20, padding: "14px 0", borderTop: "1px solid var(--border-light)" }}>
                <span className="mono-label" style={{ color: "var(--accent)", flex: "none", width: 80 }}>{c.date}</span>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{c.title}</div>
                  <p className="body" style={{ margin: 0, fontSize: 14 }}>{c.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Tiers ──────────────────────────────────────────────────────────── */}
      <section className="section" id="pricing" style={{ background: "var(--tint)" }}>
        <div className="wrap">
          <SectionHead
            os
            eyebrow="PRICING"
            title="Free during beta — and the beta is the product"
            body="Paid tiers switch on only once the product carries ₹15K MRR. Until then everything is included."
          />
          <div className="grid-4" style={{ gap: 20 }}>
            {OS_TIERS.map((t) => (
              <div key={t.name} className={`card${t.highlighted ? " card-highlight-os" : ""}`} style={{ display: "flex", flexDirection: "column" }}>
                <div className="mono-label" style={{ color: t.highlighted ? "var(--accent)" : "var(--text-muted)", marginBottom: 8 }}>
                  {t.highlighted ? "AVAILABLE NOW" : "PLANNED"}
                </div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{t.name}</div>
                <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.03em", margin: "6px 0" }}>{t.price}</div>
                <div className="meta" style={{ marginBottom: 12 }}>{t.note}</div>
                <div style={{ flex: 1 }}>
                  {t.lines.map((l) => (
                    <Tick key={l}>{l}</Tick>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Why + founder ──────────────────────────────────────────────────── */}
      <section className="section">
        <div className="wrap">
          <div className="grid-3" style={{ marginBottom: 44 }}>
            {OS_WHY.map((w) => (
              <Reveal key={w.no}>
                <div>
                  <div className="mono" style={{ fontSize: 22, color: "var(--accent)", marginBottom: 8 }}>{w.no}</div>
                  <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>{w.title}</div>
                  <p className="body" style={{ margin: 0, fontSize: 14 }}>{w.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
          <div className="card" style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ width: 96, flex: "none" }}>
              <ImageSlot label="FOUNDER PHOTO" height={96} />
            </div>
            <div style={{ flex: "1 1 380px" }}>
              <p style={{ fontSize: 15, lineHeight: 1.6, color: "var(--text-secondary)", margin: "0 0 8px" }}>{OS_FOUNDER_QUOTE}</p>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Pardeep Sharma · Founder, Anutech Digital</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 34 }}>
            <a href={OS_SIGNUP} target="_blank" rel="noopener" className="btn btn-os">Start free trial</a>
            <a href={OS_DEMO} target="_blank" rel="noopener" className="btn btn-outline">Explore the interactive demo</a>
          </div>
        </div>
      </section>
    </>
  );
}
