import type { Metadata } from "next";
import { DASH_STATS, DASH_DOMAINS, DASH_INVOICES, DASH_TICKETS } from "@/lib/data/misc";
import { RateTable } from "@/components/ui/RateTable";

export const metadata: Metadata = { title: "Client area — demo" };

/**
 * The demo client area — explicitly demo data (the banner says so on the page). Expiry
 * dates colour-code: danger when imminent, warning when soon; invoices green when paid.
 */
export default function DashboardPage() {
  return (
    <section className="section rise">
      <div className="wrap">
        <div className="mono-label" style={{ display: "inline-block", padding: "6px 12px", borderRadius: 999, background: "var(--tint)", border: "1px solid var(--border)", color: "var(--text-muted)", marginBottom: 18 }}>
          DEMO DATA — THE REAL CLIENT AREA ARRIVES WITH LOGIN
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap", marginBottom: 26 }}>
          <h1 className="h1-narrow" style={{ flex: 1 }}>Studio Anka</h1>
          <a className="btn btn-outline btn-sm" href="/quote">Add a service</a>
          <a className="btn btn-primary btn-sm" href="/support">Message support</a>
        </div>

        <div className="grid-4" style={{ marginBottom: 34 }}>
          {DASH_STATS.map((s) => (
            <div key={s.label} className="card" style={{ padding: 18 }}>
              <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.03em", color: "primary" in s && s.primary ? "var(--primary)" : "var(--text)" }}>{s.value}</div>
              <div className="mono-label" style={{ color: "var(--text-muted)" }}>{s.label}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.5fr .7fr", gap: 34, alignItems: "start" }} data-grid>
          <div style={{ display: "flex", flexDirection: "column", gap: 30 }}>
            <div>
              <h2 className="h2-sub" style={{ marginBottom: 14 }}>Domains</h2>
              <RateTable
                head={["DOMAIN", "EXPIRES", "RENEWAL", "AUTO-RENEW"]}
                rows={DASH_DOMAINS.map((d) => [
                  <span key="a" className="mono">{d.name}</span>,
                  <span key="b" style={{ color: d.expiryColor, fontWeight: 600 }}>{d.expires}</span>,
                  d.renewal,
                  <span key="d" style={{ color: d.autoColor, fontWeight: 600 }}>{d.auto}</span>,
                ])}
              />
            </div>
            <div>
              <h2 className="h2-sub" style={{ marginBottom: 14 }}>Invoices</h2>
              <RateTable
                head={["NUMBER", "DATE", "AMOUNT", "STATUS"]}
                rows={DASH_INVOICES.map((i) => [
                  <span key="a" className="mono">{i.no}</span>,
                  i.date,
                  <b key="c">{i.amount}</b>,
                  <span key="d" style={{ color: i.color, fontWeight: 600 }}>{i.status}</span>,
                ])}
              />
            </div>
          </div>

          <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="card" style={{ padding: 18 }}>
              <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 10 }}>MAIL STORAGE</div>
              <div style={{ height: 8, background: "var(--border-hairline)", borderRadius: 999, overflow: "hidden", marginBottom: 8 }}>
                <div style={{ width: "31%", height: "100%", background: "var(--primary)" }} />
              </div>
              <div className="meta">31% of the pooled 190 GB used</div>
            </div>
            <div className="card" style={{ padding: 18 }}>
              <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 10 }}>OPEN CONVERSATIONS</div>
              {DASH_TICKETS.map((t) => (
                <div key={t.subject} style={{ padding: "8px 0", borderTop: "1px solid var(--border-hairline)" }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{t.subject}</div>
                  <div className="meta" style={{ fontSize: 12 }}>{t.meta}</div>
                </div>
              ))}
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}
