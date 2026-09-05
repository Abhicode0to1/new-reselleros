"use client";

/**
 * HomeV2 — the email-first home ("Anutech Home v2" handoff, 5 Sep 2026),
 * rebuilt to the handoff's HIGH-FIDELITY design (Pardeep: the zip's home design
 * is much better). Two questions in order — which suite, then which edition —
 * ending in Buy / Start trial / Get a quote.
 *
 * This is a faithful port of the design's own visual language (Archivo + IBM
 * Plex Mono, the blue #1668E3 primary with a GREEN #0F7B4F trust accent on the
 * selected suite and the recommended edition, the exact card spacing, shadows
 * and typography) rendered with inline styles — the same approach as the
 * DomainLanding / HostingLanding pages. It shares the blue services chrome, so
 * it renders only its body; the chrome (utility bar, header, CtaBand, footer,
 * cart drawer) wraps it via the (marketing) layout.
 *
 * REAL DATA only: editions from LICENCE_EDITIONS, features from EDITION_MATRICES,
 * catalogue/trust/reviews from copy.ts. CTAs go to WhatsApp (buy/trial) and
 * /quote — no fake instant licence checkout. Conversion + SEO/AI decisions from
 * the 5 Sep web research (annual-default + absolute-₹ saving, GST/ITC line by
 * the price, comparison table with literal values, FAQ that feeds FAQPage).
 */
import { useEffect, useState } from "react";
import Link from "@/site/components/ui/SiteLink";
import { LICENCE_EDITIONS, EDITION_MATRICES } from "@/site/lib/data/catalog";
import { CATALOGUE, TRUST, REVIEWS } from "@/site/lib/data/copy";
import { WHATSAPP_URL, COMPANY } from "@/site/lib/config";
import { HOME_FAQS } from "@/site/lib/data/home-faqs";

/* Design tokens — the handoff's exact palette. */
const C = {
  ink: "#0C1116", ink2: "#2A333D", body: "#4A5560", sec: "#5C6672", faint: "#8A939E",
  blue: "#1668E3", blueDk: "#0A47A0", green: "#0F7B4F", greenT: "#EEF7F0", greenT2: "#E7F4ED",
  surf: "#fff", surfT: "#FBFCFE", sectT: "#F7FAFD", strip: "#F5F7FB", stripBd: "#E6EAF0",
  border: "#D6DCE4", borderL: "#E0E5EC", hair: "#EEF1F5", strong: "#C6CED8", tableHead: "#EEF2F8",
};
const MONO = "var(--font-mono), 'IBM Plex Mono', monospace";
const BTN_PRIMARY = "linear-gradient(180deg, #1668E3, #0A47A0)";
const SH_CARD = "0 12px 30px -26px rgba(12,17,22,.3)";
const SH_GREEN = "0 20px 46px -30px rgba(15,123,79,.55)";
const SH_BTN = "0 12px 26px -16px rgba(22,104,227,.7)";

const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const WA = (text: string) => `${WHATSAPP_URL}?text=${encodeURIComponent(text)}`;

type VendorKey = "gw" | "ms" | "zoho";
type Billing = "annual" | "monthly";

interface Vendor {
  key: VendorKey; name: string; logo: string; logoH: number; desc: string;
  prefix: string; matrix: string | null; popular: string; blurb: string; sub: string;
}
const VENDORS: Vendor[] = [
  { key: "gw", name: "Google Workspace", logo: "/logo-google-workspace-wordmark.png", logoH: 20, desc: "Gmail, Meet and Drive on your own domain", prefix: "GW ", matrix: "Google Workspace", popular: "GW Business Standard",
    blurb: "Google Workspace has three editions — which one?", sub: "The only difference is storage and controls. Gmail, Docs, Meet and Gemini are in all three — up to 300 users." },
  { key: "ms", name: "Microsoft 365", logo: "/logo-microsoft-365-trim.png", logoH: 24, desc: "Outlook, Teams and OneDrive for your team", prefix: "M365 ", matrix: "Microsoft 365", popular: "M365 Business Standard",
    blurb: "Microsoft 365 — Basic or Standard?", sub: "Both include Outlook, Teams and 1 TB OneDrive. Standard adds the desktop Office apps you install on your machine." },
  { key: "zoho", name: "Zoho Workplace", logo: "/logo-zoho-trim.png", logoH: 24, desc: "Cheapest full suite — mail plus Writer, Sheet and Show", prefix: "Zoho", matrix: null, popular: "Zoho Workplace",
    blurb: "Zoho Workplace — one simple edition.", sub: "Mail plus Writer, Sheet and Show, 30 GB per user. The cheapest way onto your own domain with a full office suite." },
];
const LABEL: Record<string, string> = {
  "GW Business Starter": "Business Starter", "GW Business Standard": "Business Standard", "GW Business Plus": "Business Plus",
  "M365 Business Basic": "Business Basic", "M365 Business Standard": "Business Standard", "Zoho Workplace": "Workplace Standard",
};
const DESC: Record<string, string> = {
  "GW Business Starter": "Small team — Gmail, Drive and Meet are enough",
  "GW Business Standard": "Teams that keep more files and meeting recordings",
  "GW Business Plus": "Compliance, Vault and larger meetings",
  "M365 Business Basic": "Web and mobile Office, Outlook and Teams",
  "M365 Business Standard": "Adds the desktop Office apps on your machine",
  "Zoho Workplace": "The full office suite at the lowest price",
};
const ZOHO_FEATURES = ["Custom email on your domain", "Mail, Writer, Sheet, Show, Calendar", "30 GB per user", "IMAP, POP and mobile apps", "Migration done by us, free"];

const editionsFor = (v: Vendor) => LICENCE_EDITIONS.filter((e) => e.name.startsWith(v.prefix));
function featuresFor(v: Vendor, i: number): string[] {
  if (!v.matrix) return ZOHO_FEATURES;
  const m = EDITION_MATRICES[v.matrix];
  if (!m) return [];
  const out: string[] = [];
  for (const row of m.rows) {
    const [label, ...cells] = row;
    if (/price|user cap/i.test(label)) continue;
    const cell = cells[i];
    if (cell && cell !== "—") out.push(cell === "Yes" ? label : `${label}: ${cell}`);
    if (out.length >= 5) break;
  }
  return out;
}

const wrap = (extra?: React.CSSProperties): React.CSSProperties => ({ maxWidth: 1180, margin: "0 auto", padding: "0 48px", ...extra });
const eyebrow: React.CSSProperties = { fontFamily: MONO, fontSize: 10.5, fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", color: C.blue };
const monoNum = (extra?: React.CSSProperties): React.CSSProperties => ({ fontFamily: MONO, fontVariantNumeric: "tabular-nums", ...extra });

export function HomeV2() {
  const [vendorKey, setVendorKey] = useState<VendorKey>("gw");
  const [billing, setBilling] = useState<Billing>("annual");
  const [seats, setSeats] = useState(1);
  const [compareOpen, setCompareOpen] = useState(false);
  const [openFaq, setOpenFaq] = useState(0);
  const [w, setW] = useState(1200);

  useEffect(() => {
    const m = () => setW(Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0));
    window.addEventListener("resize", m); m();
    return () => window.removeEventListener("resize", m);
  }, []);
  const mob = w < 980;

  const vendor = VENDORS.find((v) => v.key === vendorKey)!;
  const annual = billing === "annual";
  const rateOf = (e: (typeof LICENCE_EDITIONS)[number]) => (annual ? e.annual : e.monthly);

  const allAnnual = LICENCE_EDITIONS.map((e) => e.annual);
  const heroMin = Math.min(...allAnnual), heroMax = Math.max(...allAnnual);
  const maxSavePct = Math.max(...LICENCE_EDITIONS.map((e) => Math.round((1 - e.annual / e.monthly) * 100)));

  const vendorEditions = editionsFor(vendor);
  const popularEd = vendorEditions.find((e) => e.name === vendor.popular) ?? vendorEditions[0];
  const savePerYear = (popularEd.monthly - popularEd.annual) * 12;
  const savePct = Math.round((1 - popularEd.annual / popularEd.monthly) * 100);

  return (
    <div style={{ background: C.surf, color: C.body, fontFamily: "var(--font-sans), 'Archivo', system-ui, sans-serif" }}>
      {/* ── HERO: pick a suite ─────────────────────────────────────────────── */}
      <section style={wrap({ padding: "34px 48px 6px", textAlign: "center" })}>
        <div style={eyebrow}>Google Premier Partner · Delhi · Since 2014</div>
        <h1 style={{ fontSize: mob ? 30 : 38, fontWeight: 700, letterSpacing: "-0.04em", lineHeight: 1.06, margin: "12px auto", maxWidth: 900, color: C.ink, textWrap: "balance" as const }}>
          Business mail and Office — in rupees, supported on WhatsApp.
        </h1>
        <p style={{ fontSize: 16.5, lineHeight: 1.55, color: C.body, margin: "0 auto 6px", maxWidth: 760, textWrap: "pretty" as const }}>
          <b style={{ fontWeight: 600, color: C.ink }}>From {inr(heroMin)} to {inr(heroMax)}/user/mo</b> — Google Workspace, Microsoft 365 and Zoho, all three rates published on this page. Pick one to see the price for your team.
        </p>
        <p style={{ fontSize: 13.5, fontWeight: 600, color: C.green, margin: "0 auto 20px" }}>
          Annual billing saves up to {maxSavePct}% · GST invoice in ₹, input-credit eligible.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "repeat(3, minmax(0,1fr))", gap: 12, maxWidth: 860, margin: "0 auto 14px", textAlign: "left" }}>
          {VENDORS.map((v) => {
            const from = Math.min(...editionsFor(v).map((e) => e.annual));
            const perDay = Math.round((from * 1.18 * 12) / 365);
            const on = v.key === vendorKey;
            const rec = v.key === "gw";
            return (
              <button key={v.key} onClick={() => { setVendorKey(v.key); document.getElementById("products")?.scrollIntoView({ behavior: "smooth", block: "start" }); }} aria-pressed={on}
                style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", textAlign: "left", fontFamily: "inherit", padding: "16px 18px", borderRadius: 12, cursor: "pointer",
                  background: on ? C.greenT : C.surf, border: `1px solid ${on ? C.green : C.borderL}`, boxShadow: on ? SH_GREEN : SH_CARD }}>
                <span style={{ display: "flex", alignItems: "center", width: "100%", minHeight: 20, marginBottom: 2 }}>
                  {rec && <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: C.green, background: C.greenT2, padding: "3px 7px", borderRadius: 999, whiteSpace: "nowrap" }}>Most teams pick this</span>}
                </span>
                <span style={{ display: "flex", alignItems: "center", width: "100%", minHeight: 24 }}>
                  <img src={v.logo} alt={v.name} style={{ display: "block", height: v.logoH, width: "auto", maxWidth: "100%", objectFit: "contain" }} />
                </span>
                <span style={{ display: "flex", alignItems: "baseline", gap: 5, marginTop: 9 }}>
                  <span style={monoNum({ fontSize: 26, fontWeight: 500, letterSpacing: "-0.03em", color: C.ink })}>from {inr(from)}</span>
                  <span style={{ fontSize: 12, color: C.sec }}>/user/mo + GST</span>
                </span>
                <span style={{ display: "block", fontSize: 12, color: C.sec, marginTop: 2 }}>≈ {inr(perDay)} per user a day, GST included</span>
                <span style={{ display: "block", fontSize: 12.5, lineHeight: 1.4, color: C.ink2, marginTop: 9, minHeight: 36 }}>{v.desc}</span>
                <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.blue, marginTop: 10 }}>See editions →</span>
              </button>
            );
          })}
        </div>
        <p style={{ fontSize: 13, color: C.sec, margin: 0 }}>
          Not sure? <a href={WA("Hi Anutech — here's our current email bill, can you compare and quote?")} target="_blank" rel="noopener" style={{ color: C.green, fontWeight: 600 }}>Send your current bill on WhatsApp</a> — we compare and reply in writing.{"  "}
          <button onClick={() => { setCompareOpen(true); setTimeout(() => document.getElementById("compare")?.scrollIntoView({ behavior: "smooth" }), 30); }} style={{ background: "none", border: "none", cursor: "pointer", color: C.blue, fontWeight: 600, fontSize: 13, fontFamily: "inherit" }}>Compare editions side by side →</button>
        </p>
      </section>

      {/* ── PRODUCT: pick an edition ───────────────────────────────────────── */}
      <section id="products" style={wrap({ padding: "44px 48px 8px", scrollMarginTop: 12 })}>
        {/* sticky strip */}
        <div style={{ position: "sticky", top: 69, zIndex: 60, display: "grid", gridTemplateColumns: mob ? "1fr" : "auto 1fr auto", alignItems: "center", gap: 18, padding: "10px 14px", background: C.strip, border: `1px solid ${C.stripBd}`, borderRadius: 14, backdropFilter: "blur(6px)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
            <span style={{ fontSize: 14, color: C.ink2 }}>Users</span>
            <span style={{ display: "inline-flex", alignItems: "center", background: C.surf, border: `1px solid #DDE3EB`, borderRadius: 8, overflow: "hidden" }}>
              <input value={seats} inputMode="numeric" aria-label="Number of users"
                onChange={(e) => setSeats(Math.max(1, Math.min(5000, Number(e.target.value.replace(/\D/g, "")) || 1)))}
                style={{ width: 52, textAlign: "center", fontFamily: MONO, fontSize: 14, padding: "7px 0", border: "none", outline: "none", color: C.ink, background: C.surf }} />
              <span style={{ display: "flex", flexDirection: "column", borderLeft: `1px solid ${C.hair}` }}>
                <button onClick={() => setSeats((s) => Math.min(5000, s + 1))} aria-label="One more user" style={{ fontFamily: "inherit", fontSize: 9, lineHeight: 1, padding: "3px 7px", border: "none", background: C.surf, color: C.sec, cursor: "pointer" }}>▲</button>
                <button onClick={() => setSeats((s) => Math.max(1, s - 1))} aria-label="One less user" style={{ fontFamily: "inherit", fontSize: 9, lineHeight: 1, padding: "3px 7px", border: "none", borderTop: `1px solid ${C.hair}`, background: C.surf, color: C.sec, cursor: "pointer" }}>▼</button>
              </span>
            </span>
            <span style={{ fontSize: 12, color: C.sec, whiteSpace: "nowrap" }}>prices update as you type</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minWidth: 0 }}>
            <img src={vendor.logo} alt={vendor.name} style={{ display: "block", height: vendor.logoH, width: "auto", maxWidth: "100%", objectFit: "contain" }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, minWidth: 0 }}>
            <span style={{ fontSize: 13.5, lineHeight: 1.35, color: C.ink2 }}>
              <b style={{ fontWeight: 600, color: C.ink, whiteSpace: "nowrap" }}>{annual ? "Annual" : "Monthly"}</b>{" "}
              <span style={{ color: C.green }}>{annual ? `saves ${savePct}% · ${inr(savePerYear)}/user/yr` : "flexible"}</span>
            </span>
            <button onClick={() => setBilling(annual ? "monthly" : "annual")} role="switch" aria-checked={annual} aria-label="Annual commitment"
              style={{ display: "flex", alignItems: "center", justifyContent: annual ? "flex-end" : "flex-start", width: 42, height: 22, flex: "none", padding: 3, border: "none", borderRadius: 999, cursor: "pointer", background: annual ? C.green : C.strong }}>
              <span aria-hidden style={{ width: 16, height: 16, flex: "none", borderRadius: 999, background: "#fff", boxShadow: "0 1px 3px rgba(12,17,22,.3)" }} />
            </button>
          </div>
        </div>

        <div style={{ height: 18 }} />

        <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : ".82fr 2.18fr", gap: mob ? 24 : 36, alignItems: "stretch" }}>
          {/* left explainer */}
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ ...eyebrow, marginBottom: 10 }}>Premier Partner · Since 2014</div>
            <h2 style={{ fontSize: 27, fontWeight: 700, letterSpacing: "-0.035em", lineHeight: 1.1, margin: "0 0 10px", color: C.ink, textWrap: "balance" as const }}>{vendor.blurb}</h2>
            <p style={{ fontSize: 14.5, lineHeight: 1.5, color: C.body, margin: "0 0 14px", textWrap: "pretty" as const }}>{vendor.sub}</p>
            <p style={{ fontSize: 12.5, color: C.sec, margin: "auto 0 0", paddingTop: 16, borderTop: `1px solid ${C.borderL}` }}>
              <b style={{ fontWeight: 600, color: C.ink }}>Set users and billing above</b> — totals update live. Every rate is + 18% GST, invoiced in ₹ by {COMPANY.short} — input-credit eligible. Nothing is charged until you approve.
            </p>
          </div>

          {/* edition trio */}
          <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : `repeat(${Math.min(vendorEditions.length, 3)}, minmax(0,1fr))`, gap: 16, alignItems: "stretch" }}>
            {vendorEditions.map((e, i) => {
              const rate = rateOf(e);
              const pop = e.name === vendor.popular;
              const feats = featuresFor(vendor, i);
              const total = annual ? `${inr(e.annual * 12 * seats)}/yr` : `${inr(e.monthly * seats)}/mo`;
              const buyHref = WA(`Hi Anutech — I'd like to buy ${vendor.name} ${LABEL[e.name] ?? e.name} for ${seats} user${seats > 1 ? "s" : ""} (${annual ? "annual" : "monthly"}). Please send the payment link.`);
              return (
                <div key={e.name} style={{ display: "flex", flexDirection: "column", minHeight: 352, padding: 18, border: `1px solid ${pop ? C.green : C.border}`, borderRadius: 12, background: pop ? C.greenT : C.surf, boxShadow: pop ? SH_GREEN : SH_CARD }}>
                  {/* head */}
                  <div style={{ margin: "-18px -18px 10px", padding: "9px 18px 8px", background: pop ? C.greenT : C.surfT, borderBottom: `1px solid ${C.hair}`, borderRadius: "12px 12px 0 0" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-0.02em", color: C.ink }}>{LABEL[e.name] ?? e.name}</span>
                        {pop && <span style={{ fontFamily: MONO, fontSize: 8, fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: C.green, background: "#fff", border: `1px solid ${C.green}`, padding: "2px 5px", borderRadius: 999 }}>Popular</span>}
                      </span>
                      <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                        <span style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                          <span style={monoNum({ fontSize: 19, fontWeight: 500, letterSpacing: "-0.03em", color: C.ink })}>{inr(rate)}</span>
                          <span style={{ fontSize: 10.5, color: C.sec }}>/user/mo</span>
                        </span>
                        <span style={{ fontSize: 10, lineHeight: 1.3, color: C.sec, textAlign: "right", marginTop: 1 }}>{total} · {seats} user{seats > 1 ? "s" : ""} + GST</span>
                      </span>
                    </div>
                  </div>
                  {/* top buy */}
                  <a href={buyHref} target="_blank" rel="noopener" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 13.5, fontWeight: 600, padding: "11px 8px", borderRadius: 8, background: BTN_PRIMARY, color: "#fff", border: "none", marginBottom: 12, boxShadow: SH_BTN, textDecoration: "none" }}>
                    <CartIcon /> Buy now
                  </a>
                  <p style={{ fontSize: 12.5, lineHeight: 1.45, color: C.sec, margin: "0 0 12px", minHeight: 36 }}>{DESC[e.name] ?? e.note}</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
                    {feats.map((f) => (
                      <span key={f} style={{ display: "flex", gap: 9, fontSize: 12.5, lineHeight: 1.4, color: C.ink2 }}>
                        <svg aria-hidden viewBox="0 0 24 24" width="15" height="15" fill="none" stroke={C.blue} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none", marginTop: 1 }}><path d="M20 6 9 17l-5-5" /></svg>
                        <span>{f}</span>
                      </span>
                    ))}
                  </div>
                  {/* trial / quote */}
                  <div style={{ display: "flex", gap: 7, marginTop: "auto", paddingTop: 14 }}>
                    <a href={WA(`Hi Anutech — I'd like a free trial of ${vendor.name} ${LABEL[e.name] ?? e.name}.`)} target="_blank" rel="noopener" style={{ flex: 1, textAlign: "center", fontSize: 12.5, fontWeight: 600, padding: "9px 6px", borderRadius: 8, background: C.surf, color: C.ink, border: `1px solid ${C.strong}`, textDecoration: "none" }}>Trial</a>
                    <Link href="/quote" style={{ flex: 1, textAlign: "center", fontSize: 12.5, fontWeight: 600, padding: "9px 6px", borderRadius: 8, background: C.surf, color: C.ink, border: `1px solid ${C.border}` }}>Quote</Link>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── COMPARE ────────────────────────────────────────────────────────── */}
      <section id="compare" style={wrap({ padding: "40px 48px", scrollMarginTop: 80 })}>
        <button onClick={() => setCompareOpen((v) => !v)} aria-expanded={compareOpen} style={{ width: "100%", background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0, fontFamily: "inherit" }}>
          <div style={eyebrow}>Compare editions</div>
          <h2 style={{ fontSize: 27, fontWeight: 700, letterSpacing: "-0.035em", color: C.ink, margin: "8px 0 0" }}>{vendor.name} — every edition, in the open <span style={{ color: C.blue }}>{compareOpen ? "▲" : "▼"}</span></h2>
          <p style={{ fontSize: 14, color: C.sec, margin: "6px 0 0" }}>Real feature values, not adjectives. GST 18% is billed separately on every edition.</p>
        </button>
        {compareOpen && vendor.matrix && EDITION_MATRICES[vendor.matrix] && (
          <div style={{ border: `1px solid ${C.borderL}`, borderRadius: 12, overflow: "hidden", marginTop: 16 }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
                <thead>
                  <tr style={{ background: C.tableHead }}>
                    <th style={{ textAlign: "left", padding: "12px 16px", fontSize: 12.5, fontWeight: 600, color: C.ink2 }}>Feature</th>
                    {EDITION_MATRICES[vendor.matrix].cols.map((c) => (
                      <th key={c} style={{ textAlign: "left", padding: "12px 16px", fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.08em", color: C.ink2 }}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {EDITION_MATRICES[vendor.matrix].rows.map((row) => (
                    <tr key={row[0]} style={{ borderTop: `1px solid ${C.hair}` }}>
                      <td style={{ padding: "11px 16px", fontSize: 13, color: C.sec }}>{row[0]}</td>
                      {row.slice(1).map((cell, j) => (
                        <td key={j} style={{ padding: "11px 16px", fontSize: 13, fontFamily: cell === "Yes" || cell === "—" ? "inherit" : MONO, color: cell === "—" ? C.faint : cell === "Yes" ? C.green : C.ink }}>
                          {cell === "Yes" ? "✓" : cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {compareOpen && !vendor.matrix && (
          <p style={{ fontSize: 14, color: C.body, marginTop: 12 }}>Zoho Workplace is a single Standard edition at {inr(90)}/user/mo (annual) — mail plus Writer, Sheet and Show, 30 GB per user. Ask on WhatsApp for the full feature list.</p>
        )}
      </section>

      {/* ── ORDER FLOW ─────────────────────────────────────────────────────── */}
      <section style={{ background: C.sectT, borderTop: `1px solid ${C.borderL}`, borderBottom: `1px solid ${C.borderL}` }}>
        <div style={wrap({ padding: "44px 48px" })}>
          <div style={eyebrow}>After you order</div>
          <h2 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.03em", color: C.ink, margin: "8px 0 20px", textWrap: "balance" as const }}>You have the price. The next step takes eleven minutes.</h2>
          <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "repeat(3,1fr)", gap: 16 }}>
            {[
              { n: "01", t: "You approve", b: "Pick an edition and seat count. We send a GST quote in ₹ — nothing is charged until you say yes." },
              { n: "02", t: "We set it up", b: "Licences provisioned, DNS/MX wired, and your old mail migrated by us — outside your working hours." },
              { n: "03", t: "You're live", b: "Mailboxes on your own domain, admin handed over, and one person on WhatsApp who can change your account." },
            ].map((s) => (
              <div key={s.n} style={{ background: C.surf, border: `1px solid ${C.borderL}`, borderRadius: 12, padding: 20, boxShadow: SH_CARD }}>
                <div style={{ ...eyebrow, marginBottom: 8 }}>{s.n}</div>
                <div style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 6 }}>{s.t}</div>
                <p style={{ fontSize: 14, lineHeight: 1.5, color: C.body, margin: 0 }}>{s.b}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CATALOGUE ──────────────────────────────────────────────────────── */}
      <section style={wrap({ padding: "44px 48px" })}>
        <div style={eyebrow}>Everything else we sell</div>
        <h2 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.03em", color: C.ink, margin: "8px 0 6px", textWrap: "balance" as const }}>Domains, hosting, SSL — same published-price rule</h2>
        <p style={{ fontSize: 15, color: C.body, margin: "0 0 20px" }}>Every rate on the card, GST 18% separate, renewal price shown up front.</p>
        <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(4,1fr)", gap: 16 }}>
          {CATALOGUE.filter((c) => c.name !== "Business email").map((c) => (
            <Link key={c.name} href={c.href as never} style={{ display: "block", background: C.surf, border: `1px solid ${C.borderL}`, borderRadius: 12, padding: 18, boxShadow: SH_CARD, textDecoration: "none", color: "inherit" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, gap: 8 }}>
                <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em", color: C.ink }}>{c.name}</span>
                <span style={monoNum({ fontSize: 12, color: C.blue })}>{c.from}</span>
              </div>
              <p style={{ fontSize: 13.5, lineHeight: 1.5, color: C.body, margin: "0 0 12px" }}>{c.body}</p>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {c.chips.map((chip) => (
                  <span key={chip} style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", border: `1px solid ${C.borderL}`, borderRadius: 4, padding: "3px 7px", color: C.sec }}>{chip}</span>
                ))}
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* ── TRUST ──────────────────────────────────────────────────────────── */}
      <section style={{ background: C.sectT, borderTop: `1px solid ${C.borderL}` }}>
        <div style={wrap({ padding: "44px 48px" })}>
          <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(4,1fr)", gap: 16, marginBottom: 28 }}>
            {TRUST.map((f) => (
              <div key={f.label} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.03em", color: ("primary" in f && f.primary) ? C.blue : C.ink }}>{f.value}</div>
                <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: C.sec, marginTop: 4 }}>{f.label}</div>
              </div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "repeat(3,1fr)", gap: 16 }}>
            {REVIEWS.filter((r, i, a) => a.findIndex((x) => x.name === r.name) === i).map((r) => (
              <div key={r.name} style={{ background: C.surf, border: `1px solid ${C.borderL}`, borderRadius: 12, padding: 20, boxShadow: SH_CARD }}>
                <div aria-label={`${r.stars.split("★").length - 1} star review`} style={{ color: "#B7791F", letterSpacing: 2, marginBottom: 10 }}>{r.stars}</div>
                <p style={{ fontSize: 15, lineHeight: 1.55, margin: "0 0 14px", color: C.ink2 }}>&ldquo;{r.quote}&rdquo;</p>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>{r.name}</div>
                <div style={{ fontSize: 13, color: C.sec }}>{r.role}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ ────────────────────────────────────────────────────────────── */}
      <section id="faq" style={wrap({ padding: "44px 48px", maxWidth: 820 })}>
        <div style={{ ...eyebrow, textAlign: "center" }}>Questions</div>
        <h2 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.03em", color: C.ink, margin: "8px 0 18px", textAlign: "center", textWrap: "balance" as const }}>The five things buyers ask us first</h2>
        {HOME_FAQS.map((f, i) => {
          const open = openFaq === i;
          return (
            <div key={f.q} style={{ borderTop: `1px solid ${C.borderL}` }}>
              <button onClick={() => setOpenFaq(open ? -1 : i)} aria-expanded={open} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, background: "none", border: "none", cursor: "pointer", padding: "18px 0", textAlign: "left", fontFamily: "inherit" }}>
                <span style={{ fontSize: 16.5, fontWeight: 600, color: open ? C.blue : C.ink }}>{f.q}</span>
                <span style={{ fontFamily: MONO, fontSize: 19, color: C.blue }}>{open ? "−" : "+"}</span>
              </button>
              {open && <p style={{ fontSize: 15, lineHeight: 1.6, color: C.body, padding: "0 0 20px", margin: 0 }}>{f.a}</p>}
            </div>
          );
        })}
      </section>

      {/* ── RESELLEROS ─────────────────────────────────────────────────────── */}
      <section style={{ background: "#FFF6F0", borderTop: "1px solid #F5D9C6" }}>
        <div style={wrap({ padding: "40px 48px" })}>
          <div style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", color: "#C2410C", marginBottom: 10 }}>For resellers</div>
          <h2 style={{ fontSize: 27, fontWeight: 700, letterSpacing: "-0.03em", color: C.ink, margin: "0 0 8px" }}>Resell this for a living? Run it on ResellerOS.</h2>
          <p style={{ fontSize: 15, lineHeight: 1.55, color: C.body, margin: "0 0 16px", maxWidth: 640 }}>Our own software: subscriptions and seats, GST quotes and invoices, renewals on autopilot, bank reconciliation — free during beta.</p>
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <Link href="/reselleros" style={{ background: "#C2410C", color: "#fff", borderRadius: 8, padding: "12px 20px", fontSize: 14, fontWeight: 600, textDecoration: "none" }}>Explore ResellerOS →</Link>
            <Link href="/login" style={{ fontWeight: 600, color: "#C2410C" }}>Already a member? Log in</Link>
          </div>
        </div>
      </section>
    </div>
  );
}

function CartIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
      <circle cx="9" cy="20" r="1.4" /><circle cx="18" cy="20" r="1.4" /><path d="M2 3h2.2l2.6 12.2h12.1L21.5 7H6" />
    </svg>
  );
}
