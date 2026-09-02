"use client";
/**
 * The rest of the global chrome: utility bar, breadcrumb, CTA band, footer, the persistent
 * WhatsApp pill and the consent banner. One file, because every piece is a fixed band with
 * no state of its own except consent — splitting them into six files would scatter what the
 * README describes as one system ("Global Chrome (every route)").
 */
import Image from "next/image";
import Link from "@/site/components/ui/SiteLink";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { COMPANY, WHATSAPP_URL } from "@/site/lib/config";

export function UtilityBar() {
  return (
    <div style={{ background: "var(--dark)", color: "#C3CBD6", fontSize: 13, padding: "9px 0" }}>
      <div className="wrap" style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <span>Free migration on every plan · GST invoice on every order</span>
        <span className="hide-mobile" style={{ display: "flex", gap: 18 }}>
          <Link href="/pricing">All prices</Link>
          <Link href="/support">Knowledge base</Link>
          <Link href="/status">Status</Link>
          <Link href="/login">Client login</Link>
        </span>
      </div>
    </div>
  );
}

/** "Home / <page title>" on every route except home. The map is the handoff's crumb map. */
const CRUMBS: Record<string, string> = {
  "/domains": "Domain registration & transfer",
  "/hosting": "cPanel web hosting",
  "/email": "Business email & productivity",
  "/email/compare-editions": "Compare editions",
  "/ssl": "SSL & security",
  "/login": "Client login",
  "/terms": "Terms of service",
  "/privacy": "Privacy policy",
  "/refund": "Refund policy",
  "/reselleros": "ResellerOS — software for resellers",
  "/reseller": "Reseller program",
  "/pricing": "Every price",
  "/why-us": "Why us",
  "/about": "About Anutech Digital",
  "/support": "Support & knowledge base",
  "/status": "System status",
  "/quote": "Get a quote",
  "/cart": "Cart",
  "/checkout": "Checkout",
  "/done": "Order placed",
  "/dashboard": "Client area",
};

export function Breadcrumb() {
  const pathname = usePathname();
  const title = CRUMBS[pathname];
  if (!title) return null;
  return (
    <div style={{ background: "var(--tint-2)", borderBottom: "1px solid var(--border-hairline)", fontSize: 13, padding: "9px 0", color: "var(--text-muted)" }}>
      <div className="wrap">
        <Link href="/" style={{ color: "var(--text-muted)" }}>Home</Link>
        <span style={{ margin: "0 8px" }}>/</span>
        <span style={{ color: "var(--text)" }}>{title}</span>
      </div>
    </div>
  );
}

export function CtaBand() {
  return (
    <section style={{ background: "var(--dark)", color: "#fff", padding: "56px 0" }}>
      <div className="wrap" style={{ display: "flex", alignItems: "center", gap: 28, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 420px" }}>
          <h2 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.03em", marginBottom: 8 }}>
            Send a headcount, get every option priced today.
          </h2>
          <p style={{ color: "var(--dark-body)", margin: 0, fontSize: 16 }}>
            Three suites, GST broken out, renewal price printed up front. No callback queue.
          </p>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <a href={WHATSAPP_URL} target="_blank" rel="noopener" className="btn btn-outline" style={{ background: "transparent", color: "#fff", borderColor: "#39434e" }}>
            WhatsApp us
          </a>
          <Link href="/quote" className="btn btn-primary">Get a quote</Link>
        </div>
      </div>
    </section>
  );
}

const FOOTER_COLS = [
  { title: "DOMAINS", links: [["Search a domain", "/domains"], ["Rate card", "/domains#rates"], ["Transfer in", "/domains"], ["All prices", "/pricing"]] },
  { title: "HOSTING", links: [["Shared hosting", "/hosting"], ["Full specification", "/hosting#specs"], ["Client area", "/dashboard"], ["System status", "/status"]] },
  { title: "EMAIL & SECURITY", links: [["Compare editions", "/email/compare-editions"], ["Business email", "/email"], ["Google Workspace", "/quote"], ["Microsoft 365", "/quote"], ["SSL certificates", "/ssl"]] },
  { title: "RESELLEROS", links: [["What it is", "/reselleros"], ["Modules", "/reselleros#modules"], ["Interactive demo", "/reselleros"], ["Pricing — free in beta", "/reselleros#pricing"]] },
  { title: "COMPANY", links: [["About Anutech", "/about"], ["Reseller program", "/reseller"], ["Why us", "/why-us"], ["Support", "/support"], ["Get a quote", "/quote"], ["Client login", "/login"], ["Terms", "/terms"], ["Privacy", "/privacy"], ["Refunds", "/refund"]] },
] as const;

export function Footer() {
  return (
    <footer style={{ background: "var(--tint-2)", borderTop: "1px solid var(--border-light)", padding: "52px 0 28px" }}>
      <div className="wrap">
        <div style={{ display: "grid", gridTemplateColumns: "1.5fr repeat(5, 1fr)", gap: 28 }} className="footer-grid">
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <Image src="/anutech-logo.png" alt="" width={30} height={30} style={{ objectFit: "contain" }} />
              <span style={{ fontSize: 16, fontWeight: 700 }}>Anutech Digital</span>
            </div>
            <p style={{ fontSize: 14, lineHeight: 1.55, color: "var(--text-secondary)", maxWidth: 260, margin: "0 0 14px" }}>
              Anutech Digital Pvt Ltd, Rohini, Delhi. Google Premier Partner since 2014. Maker of ResellerOS.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {["GST INVOICE", "UPI", "NETBANKING", "VISA / MASTERCARD"].map((b) => (
                <span key={b} className="mono-label" style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "4px 8px", color: "var(--text-muted)" }}>
                  {b}
                </span>
              ))}
            </div>
          </div>
          {FOOTER_COLS.map((col) => (
            <nav key={col.title} aria-label={col.title}>
              <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 12 }}>{col.title}</div>
              {col.links.map(([label, href]) => (
                <Link key={label} href={href as never} style={{ display: "block", fontSize: 14, color: "var(--text-secondary)", padding: "4px 0" }}>
                  {label}
                </Link>
              ))}
            </nav>
          ))}
        </div>
        <div style={{ borderTop: "1px solid var(--border-light)", marginTop: 36, paddingTop: 18, display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", fontSize: 12, color: "var(--text-muted)" }}>
          <span>© 2026 {COMPANY.name} · {COMPANY.city} · GSTIN {COMPANY.gstin}</span>
          <span>All prices exclusive of GST at 18%, stated separately on every invoice.</span>
        </div>
      </div>
      <style jsx>{`
        @media (max-width: 979px) {
          .footer-grid { grid-template-columns: 1fr 1fr !important; }
        }
      `}</style>
    </footer>
  );
}

export function WhatsAppButton() {
  return (
    <a
      href={WHATSAPP_URL}
      target="_blank"
      rel="noopener"
      aria-label="WhatsApp us — average first reply 11 minutes"
      style={{
        position: "fixed", right: 22, bottom: 22, zIndex: 90,
        display: "inline-flex", alignItems: "center", gap: 9,
        background: "var(--dark)", color: "#fff", borderRadius: 999, padding: "12px 18px",
        fontSize: 14, fontWeight: 600, boxShadow: "var(--shadow-panel)",
        transition: "background .15s ease",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--primary)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "var(--dark)")}
    >
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: "var(--bar-ok)" }} />
      WhatsApp us
      <span className="mono" style={{ fontSize: 11, color: "#9AA5B1" }}>~11 MIN</span>
    </a>
  );
}

export function ConsentBanner() {
  /* null until mounted — the banner must not flash for a visitor who already chose. */
  const [consent, setConsent] = useState<string | null | "unknown">("unknown");
  useEffect(() => {
    try {
      setConsent(window.localStorage.getItem("anutech.consent.v1"));
    } catch {
      setConsent("essential");
    }
  }, []);
  if (consent !== null) return null;

  const choose = (value: string) => {
    try { window.localStorage.setItem("anutech.consent.v1", value); } catch { /* in-memory only */ }
    setConsent(value);
  };

  return (
    <div
      role="dialog"
      aria-label="Cookie consent"
      style={{
        position: "fixed", left: 22, bottom: 22, zIndex: 95, maxWidth: 360,
        background: "#fff", border: "1px solid var(--border)", borderRadius: 10,
        padding: 18, boxShadow: "var(--shadow-panel)",
      }}
    >
      <p style={{ fontSize: 14, lineHeight: 1.5, color: "var(--text-secondary)", margin: "0 0 12px" }}>
        Essential cookies keep the cart working. Analytics cookies are set only if you accept them.
      </p>
      <div style={{ display: "flex", gap: 10 }}>
        <button className="btn btn-primary btn-sm" onClick={() => choose("all")}>Accept all</button>
        <button className="btn btn-outline btn-sm" onClick={() => choose("essential")}>Essential only</button>
      </div>
    </div>
  );
}
