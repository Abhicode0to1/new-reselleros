"use client";

/**
 * HomeV2 — the email-first home ("Anutech Home v2" handoff, 5 Sep 2026).
 *
 * The whole page answers two questions in order — WHICH suite, then WHICH
 * edition — and ends in Start trial / Get a quote / Buy. It never jumps from a
 * suite straight to checkout; that skips the edition choice.
 *
 * Built in the marketing site's OWN system (Archivo + IBM Plex Mono + the blue
 * #1668E3 primary, site.css tokens), because — unlike /domains and /hosting,
 * which are orange editorial pages — this home shares the blue services chrome.
 * It renders only its body; the shared chrome (utility bar, header, CtaBand,
 * footer, cart drawer) wraps it via the (marketing) layout.
 *
 * REAL DATA: editions from LICENCE_EDITIONS, features from EDITION_MATRICES,
 * catalogue from CATALOGUE, TLDs/hosting from catalog.ts — never invented.
 *
 * Conversion + SEO decisions come from the round-1 web research (5 Sep):
 *   · suite-first, ≤3 cards per suite, mid-tier badged "Most teams pick this"
 *   · Annual default, toggle shows the ABSOLUTE ₹ saving, not just a percent
 *   · price framed /user/mo + GST, with a per-day hook and the annual total
 *   · GST-invoice / INR / ITC-eligible trust line sits next to the price
 *   · a real comparison table with literal cell values (feeds SEO + AI)
 *   · question-style FAQ headings with self-contained answers (feeds FAQPage)
 * Honesty rules kept: renewal/annual figures shown up front, GST always stated
 * separately, nothing charged until the customer approves.
 */
import { useState } from "react";
import Link from "@/site/components/ui/SiteLink";
import { Reveal, SectionHead } from "@/site/components/ui/bits";
import { LICENCE_EDITIONS, EDITION_MATRICES } from "@/site/lib/data/catalog";
import { CATALOGUE, TRUST, REVIEWS } from "@/site/lib/data/copy";
import { WHATSAPP_URL, COMPANY } from "@/site/lib/config";
import { HOME_FAQS } from "@/site/lib/data/home-faqs";

/** ₹, Indian grouping. */
const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const WA = (text: string) => `${WHATSAPP_URL}?text=${encodeURIComponent(text)}`;

type VendorKey = "gw" | "ms" | "zoho";
type Billing = "annual" | "monthly";

interface Vendor {
  key: VendorKey;
  name: string;
  logo: string;
  logoH: number;
  desc: string;
  /** LICENCE_EDITIONS name prefix that belongs to this vendor. */
  prefix: string;
  /** EDITION_MATRICES key, or null (Zoho has no matrix). */
  matrix: string | null;
  /** The edition name that carries the "Most teams pick this" badge. */
  popular: string;
}

const VENDORS: Vendor[] = [
  { key: "gw", name: "Google Workspace", logo: "/logo-google-workspace-wordmark.png", logoH: 26, desc: "Gmail, Meet and Drive on your own domain", prefix: "GW ", matrix: "Google Workspace", popular: "GW Business Standard" },
  { key: "ms", name: "Microsoft 365", logo: "/logo-microsoft-365-trim.png", logoH: 30, desc: "Outlook, Teams and OneDrive for your team", prefix: "M365 ", matrix: "Microsoft 365", popular: "M365 Business Standard" },
  { key: "zoho", name: "Zoho Workplace", logo: "/logo-zoho-trim.png", logoH: 26, desc: "Cheapest full suite — mail plus Writer, Sheet and Show", prefix: "Zoho", matrix: null, popular: "Zoho Workplace" },
];

/** Human display label from the LICENCE_EDITIONS key. */
const LABEL: Record<string, string> = {
  "GW Business Starter": "Business Starter",
  "GW Business Standard": "Business Standard",
  "GW Business Plus": "Business Plus",
  "M365 Business Basic": "Business Basic",
  "M365 Business Standard": "Business Standard",
  "Zoho Workplace": "Workplace Standard",
};

/** Zoho has no EDITION_MATRICES row — a short, honest "what you get". */
const ZOHO_FEATURES = ["Custom email on your domain", "Mail, Writer, Sheet, Show, Calendar", "30 GB per user", "IMAP/POP, mobile apps", "Migration done by us"];

const editionsFor = (v: Vendor) => LICENCE_EDITIONS.filter((e) => e.name.startsWith(v.prefix));

/** Up to 5 "Yes" features for an edition, read from EDITION_MATRICES. */
function featuresFor(v: Vendor, editionIndex: number): string[] {
  if (!v.matrix) return ZOHO_FEATURES;
  const m = EDITION_MATRICES[v.matrix];
  if (!m) return [];
  const out: string[] = [];
  for (const row of m.rows) {
    const [label, ...cells] = row;
    if (/price|user cap/i.test(label)) continue;
    const cell = cells[editionIndex];
    if (cell && cell !== "—") out.push(cell === "Yes" ? label : `${label}: ${cell}`);
    if (out.length >= 5) break;
  }
  return out;
}

export function HomeV2() {
  const [vendorKey, setVendorKey] = useState<VendorKey>("gw");
  const [billing, setBilling] = useState<Billing>("annual");
  const [seats, setSeats] = useState(1);
  const [compareOpen, setCompareOpen] = useState(false);
  const [openFaq, setOpenFaq] = useState(0);

  const vendor = VENDORS.find((v) => v.key === vendorKey)!;
  const annual = billing === "annual";
  const rateOf = (e: (typeof LICENCE_EDITIONS)[number]) => (annual ? e.annual : e.monthly);

  const allRates = LICENCE_EDITIONS.map((e) => e.annual);
  const heroMin = Math.min(...allRates), heroMax = Math.max(...allRates);
  // Biggest annual saving across editions, for the hero's green line.
  const maxSavePct = Math.max(...LICENCE_EDITIONS.map((e) => Math.round((1 - e.annual / e.monthly) * 100)));

  const vendorEditions = editionsFor(vendor);

  // Saving shown in the billing toggle — absolute ₹/user/yr on this vendor's popular edition.
  const popularEd = vendorEditions.find((e) => e.name === vendor.popular) ?? vendorEditions[0];
  const savePerYear = (popularEd.monthly - popularEd.annual) * 12;
  const savePct = Math.round((1 - popularEd.annual / popularEd.monthly) * 100);

  return (
    <>
      {/* ── HERO: pick a suite ─────────────────────────────────────────────── */}
      <section className="section" style={{ paddingBottom: 8 }}>
        <div className="wrap" style={{ textAlign: "center" }}>
          <div className="mono-label" style={{ color: "var(--primary)", marginBottom: 12 }}>
            GOOGLE PREMIER PARTNER · DELHI · SINCE 2014
          </div>
          <h1 className="h1-page" style={{ maxWidth: 760, margin: "0 auto 12px" }}>
            Business mail and Office — in rupees, supported on WhatsApp.
          </h1>
          <p className="body-lg" style={{ maxWidth: 720, margin: "0 auto 6px" }}>
            <b style={{ fontWeight: 600, color: "var(--text)" }}>From {inr(heroMin)} to {inr(heroMax)}/user/mo</b> — Google
            Workspace, Microsoft 365 and Zoho, all three rates published on this page. Pick one to see the price for your team.
          </p>
          <p style={{ color: "var(--success)", fontWeight: 600, fontSize: 14.5, margin: "0 0 24px" }}>
            Annual billing saves up to {maxSavePct}% · GST invoice in ₹, input-credit eligible.
          </p>

          {/* three suite cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, maxWidth: 900, margin: "0 auto" }} data-cards>
            {VENDORS.map((v) => {
              const eds = editionsFor(v);
              const from = Math.min(...eds.map((e) => e.annual));
              const perDay = Math.round((from * 1.18 * 12) / 365);
              const on = v.key === vendorKey;
              const isPopular = v.key === "gw";
              return (
                <button
                  key={v.key}
                  onClick={() => setVendorKey(v.key)}
                  aria-pressed={on}
                  style={{
                    textAlign: "left", cursor: "pointer", background: on ? "var(--tint)" : "#fff",
                    border: `1.5px solid ${on ? "var(--primary)" : "var(--border)"}`,
                    borderRadius: 12, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 8,
                    boxShadow: on ? "var(--shadow-highlight)" : "none", fontFamily: "inherit",
                  }}
                >
                  <span style={{ minHeight: 20, display: "flex" }}>
                    {isPopular && (
                      <span className="mono-label" style={{ background: "var(--primary)", color: "#fff", borderRadius: 999, padding: "3px 9px", fontSize: 9.5 }}>
                        MOST TEAMS PICK THIS
                      </span>
                    )}
                  </span>
                  <img src={v.logo} alt={v.name} style={{ height: v.logoH, width: "auto", objectFit: "contain", alignSelf: "flex-start" }} />
                  <span style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 2 }}>
                    <span style={{ fontFamily: "var(--font-mono), monospace", fontSize: 22, fontWeight: 600 }}>from {inr(from)}</span>
                    <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>/user/mo + GST</span>
                  </span>
                  <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>≈ {inr(perDay)} per user a day, GST included</span>
                  <span style={{ fontSize: 13.5, color: "var(--text-secondary)", minHeight: 36 }}>{v.desc}</span>
                  <span style={{ color: "var(--primary)", fontWeight: 600, fontSize: 14 }}>See editions →</span>
                </button>
              );
            })}
          </div>

          <p className="meta" style={{ marginTop: 18 }}>
            Not sure?{" "}
            <a href={WA("Hi Anutech — here's our current email bill, can you compare and quote?")} target="_blank" rel="noopener" style={{ color: "var(--primary)", fontWeight: 600 }}>
              Send your current bill on WhatsApp
            </a>{" "}
            — we compare and reply in writing.{"  "}
            <button onClick={() => { setCompareOpen(true); document.getElementById("compare")?.scrollIntoView({ behavior: "smooth" }); }}
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--primary)", fontWeight: 600, fontSize: 14, fontFamily: "inherit" }}>
              Compare all three side by side →
            </button>
          </p>
        </div>
      </section>

      {/* ── PRODUCT: pick an edition ───────────────────────────────────────── */}
      <section id="products" className="section-tight" style={{ background: "var(--tint)" }}>
        <div className="wrap">
          {/* strip: users + vendor + billing */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "space-between", background: "var(--strip-tint, #F5F7FB)", border: "1px solid var(--border-light)", borderRadius: 10, padding: "12px 16px", marginBottom: 20 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14 }}>
              <span className="mono-label" style={{ color: "var(--text-muted)" }}>USERS</span>
              <input
                type="number" min={1} max={5000} value={seats} inputMode="numeric" aria-label="Number of users"
                onChange={(e) => setSeats(Math.max(1, Math.min(5000, Number(e.target.value) || 1)))}
                style={{ width: 84, minHeight: 40, border: "1.5px solid var(--border-strong)", borderRadius: 8, padding: "8px 10px", fontSize: 15, fontFamily: "var(--font-mono), monospace" }}
              />
            </label>
            <img src={vendor.logo} alt={vendor.name} style={{ height: vendor.logoH, width: "auto", objectFit: "contain" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div role="group" aria-label="Billing period" style={{ display: "flex", background: "#fff", border: "1px solid var(--border)", borderRadius: 999, padding: 3 }}>
                {(["annual", "monthly"] as Billing[]).map((b) => {
                  const on = billing === b;
                  return (
                    <button key={b} onClick={() => setBilling(b)} aria-pressed={on}
                      style={{ cursor: "pointer", border: "none", borderRadius: 999, padding: "7px 14px", fontSize: 13.5, fontWeight: on ? 600 : 500, background: on ? "var(--primary)" : "transparent", color: on ? "#fff" : "var(--text-secondary)", fontFamily: "inherit", minHeight: 40 }}>
                      {b === "annual" ? "Annual" : "Monthly"}
                    </button>
                  );
                })}
              </div>
              <span style={{ fontSize: 13, color: "var(--success)", fontWeight: 600 }}>
                Annual saves {savePct}% · {inr(savePerYear)}/user/yr
              </span>
            </div>
          </div>

          {/* edition cards */}
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(vendorEditions.length, 3)}, 1fr)`, gap: 16 }} data-cards>
            {vendorEditions.map((e, i) => {
              const rate = rateOf(e);
              const isPopular = e.name === vendor.popular;
              const feats = featuresFor(vendor, i);
              const annualTotal = e.annual * 12 * seats;
              return (
                <Reveal key={e.name}>
                  <div style={{ background: "#fff", border: `1.5px solid ${isPopular ? "var(--primary)" : "var(--border)"}`, borderRadius: 12, padding: 20, height: "100%", display: "flex", flexDirection: "column", boxShadow: isPopular ? "var(--shadow-highlight)" : "var(--shadow-card, none)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                      <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>{LABEL[e.name] ?? e.name}</span>
                      {isPopular && <span className="mono-label" style={{ color: "var(--primary)" }}>POPULAR</span>}
                    </div>
                    <div style={{ fontSize: 13.5, color: "var(--text-secondary)", marginTop: 2 }}>{e.note}</div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 12 }}>
                      <span style={{ fontFamily: "var(--font-mono), monospace", fontSize: 30, fontWeight: 600 }}>{inr(rate)}</span>
                      <span style={{ fontSize: 13, color: "var(--text-muted)" }}>/user/mo + GST</span>
                    </div>
                    <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                      {annual ? <>billed annually · {inr(annualTotal)}/yr for {seats} user{seats > 1 ? "s" : ""} + GST</> : <>billed monthly · renews at the same rate</>}
                    </div>
                    <ul style={{ listStyle: "none", padding: 0, margin: "14px 0 16px", display: "flex", flexDirection: "column", gap: 7, flex: 1 }}>
                      {feats.map((f) => (
                        <li key={f} style={{ display: "flex", gap: 8, fontSize: 13.5, color: "var(--text-secondary)" }}>
                          <span style={{ color: "var(--success)", fontWeight: 700 }}>✓</span> {f}
                        </li>
                      ))}
                    </ul>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <a href={WA(`Hi Anutech — I'd like to buy ${vendor.name} ${LABEL[e.name] ?? e.name} for ${seats} user${seats > 1 ? "s" : ""} (${annual ? "annual" : "monthly"}). Please send the payment link.`)}
                        target="_blank" rel="noopener" className="btn btn-primary" style={{ width: "100%" }} data-primary-buy>
                        Buy now
                      </a>
                      <div style={{ display: "flex", gap: 8 }}>
                        <a href={WA(`Hi Anutech — I'd like a free trial of ${vendor.name} ${LABEL[e.name] ?? e.name}.`)} target="_blank" rel="noopener" className="btn btn-outline" style={{ flex: 1 }}>
                          Start trial
                        </a>
                        <Link href="/quote" className="btn btn-outline" style={{ flex: 1 }}>Get a quote</Link>
                      </div>
                    </div>
                  </div>
                </Reveal>
              );
            })}
          </div>

          {/* GST / trust line right under the price — the reseller's whole reason to exist */}
          <p className="meta" style={{ marginTop: 16, textAlign: "center" }}>
            Every price is <b style={{ color: "var(--text)" }}>+ 18% GST</b>, invoiced in ₹ by {COMPANY.name} (GSTIN {COMPANY.gstin}) — input-credit eligible. Migration is free, done by us. Nothing is charged until you approve.
          </p>
        </div>
      </section>

      {/* ── COMPARE: editions side by side (opens from hero / #compare) ─────── */}
      <section id="compare" className="section" style={{ scrollMarginTop: 80 }}>
        <div className="wrap">
          <button onClick={() => setCompareOpen((v) => !v)} aria-expanded={compareOpen}
            style={{ width: "100%", background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0, fontFamily: "inherit" }}>
            <SectionHead
              eyebrow="COMPARE EDITIONS"
              title={`${vendor.name} — every edition, in the open ${compareOpen ? "▲" : "▼"}`}
              body="Real feature values, not adjectives. GST 18% is billed separately on every edition."
            />
          </button>
          {compareOpen && vendor.matrix && EDITION_MATRICES[vendor.matrix] && (
            <div className="tablewrap" style={{ marginTop: 8 }}>
              <table className="rates" style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Feature</th>
                    {EDITION_MATRICES[vendor.matrix].cols.map((c) => (
                      <th key={c} style={{ textAlign: "left" }}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {EDITION_MATRICES[vendor.matrix].rows.map((row) => (
                    <tr key={row[0]}>
                      <td style={{ color: "var(--text-secondary)" }}>{row[0]}</td>
                      {row.slice(1).map((cell, j) => (
                        <td key={j} style={{ fontFamily: cell === "Yes" || cell === "—" ? "inherit" : "var(--font-mono), monospace", color: cell === "—" ? "var(--text-disabled)" : "var(--text)" }}>
                          {cell === "Yes" ? "✓" : cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {compareOpen && !vendor.matrix && (
            <p className="body" style={{ marginTop: 12 }}>Zoho Workplace is a single Standard edition at {inr(90)}/user/mo (annual) — mail plus Writer, Sheet and Show, 30 GB per user. Ask on WhatsApp for the full feature list.</p>
          )}
        </div>
      </section>

      {/* ── ORDER FLOW ─────────────────────────────────────────────────────── */}
      <section className="section-tight" style={{ background: "var(--tint)" }}>
        <div className="wrap">
          <SectionHead eyebrow="AFTER YOU ORDER" title="You have the price. The next step takes eleven minutes." />
          <div className="grid-3">
            {[
              { n: "01", t: "You approve", b: "Pick an edition and seat count. We send a GST quote in ₹ — nothing is charged until you say yes." },
              { n: "02", t: "We set it up", b: "Licences provisioned, DNS/MX wired, and your old mail migrated by us — outside your working hours." },
              { n: "03", t: "You're live", b: "Mailboxes on your own domain, admin handed over, and one person on WhatsApp who can change your account." },
            ].map((s) => (
              <Reveal key={s.n}>
                <div className="card" style={{ height: "100%" }}>
                  <div className="mono-label" style={{ color: "var(--primary)", marginBottom: 8 }}>{s.n}</div>
                  <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>{s.t}</div>
                  <p className="body" style={{ margin: 0, fontSize: 14 }}>{s.b}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── CATALOGUE (domains / hosting / ssl / reseller) ─────────────────── */}
      <section id="catalogue" className="section">
        <div className="wrap">
          <SectionHead eyebrow="EVERYTHING ELSE WE SELL" title="Domains, hosting, SSL — same published-price rule" body="Every rate on the card, GST 18% separate, renewal price shown up front." />
          <div className="grid-4" style={{ gap: 16 }}>
            {CATALOGUE.filter((c) => c.name !== "Business email").map((c) => (
              <Reveal key={c.name}>
                <Link href={c.href as never} className="card" style={{ display: "block", height: "100%" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                    <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em" }}>{c.name}</span>
                    <span className="mono" style={{ fontSize: 12.5, color: "var(--primary)" }}>{c.from}</span>
                  </div>
                  <p className="body" style={{ margin: "0 0 12px", fontSize: 14 }}>{c.body}</p>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {c.chips.map((chip) => (
                      <span key={chip} className="mono-label" style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "3px 7px", color: "var(--text-muted)" }}>{chip}</span>
                    ))}
                  </div>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── TRUST ──────────────────────────────────────────────────────────── */}
      <section id="trust" className="section-tight" style={{ background: "var(--tint)" }}>
        <div className="wrap">
          <div className="grid-4" style={{ gap: 16, marginBottom: 28 }}>
            {TRUST.map((f) => (
              <div key={f.label} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.03em", color: ("primary" in f && f.primary) ? "var(--primary)" : "var(--text)" }}>{f.value}</div>
                <div className="mono-label" style={{ color: "var(--text-muted)" }}>{f.label}</div>
              </div>
            ))}
          </div>
          <div className="grid-3">
            {REVIEWS.filter((r, i, a) => a.findIndex((x) => x.name === r.name) === i).map((r) => (
              <div key={r.name} className="card" style={{ height: "100%" }}>
                <div aria-label={`${r.stars.split("★").length - 1} star review`} style={{ color: "var(--warning)", letterSpacing: 2, marginBottom: 10 }}>{r.stars}</div>
                <p style={{ fontSize: 15, lineHeight: 1.55, margin: "0 0 14px" }}>&ldquo;{r.quote}&rdquo;</p>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{r.name}</div>
                <div className="meta">{r.role}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ (question-style, self-contained — feeds FAQPage JSON-LD) ────── */}
      <section id="faq" className="section">
        <div className="wrap" style={{ maxWidth: 820, margin: "0 auto" }}>
          <SectionHead eyebrow="QUESTIONS" title="The five things buyers ask us first" />
          {HOME_FAQS.map((f, i) => {
            const open = openFaq === i;
            return (
              <div key={f.q} style={{ borderTop: "1px solid var(--border-light)" }}>
                <button onClick={() => setOpenFaq(open ? -1 : i)} aria-expanded={open}
                  style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, background: "none", border: "none", cursor: "pointer", padding: "18px 0", textAlign: "left", fontFamily: "inherit" }}>
                  <span style={{ fontSize: 16.5, fontWeight: 600, color: open ? "var(--primary)" : "var(--text)" }}>{f.q}</span>
                  <span className="mono" style={{ fontSize: 19, color: "var(--primary)" }}>{open ? "−" : "+"}</span>
                </button>
                {open && <p className="body" style={{ padding: "0 0 20px", margin: 0 }}>{f.a}</p>}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── RESELLEROS ─────────────────────────────────────────────────────── */}
      <section id="reselleros" className="section-tight" style={{ background: "#FFF6F0" }}>
        <div className="wrap" style={{ display: "grid", gridTemplateColumns: "1fr", gap: 20 }}>
          <div>
            <div className="mono-label" style={{ color: "var(--accent)", marginBottom: 10 }}>FOR RESELLERS</div>
            <h2 className="h2-sub" style={{ marginBottom: 8 }}>Resell this for a living? Run it on ResellerOS.</h2>
            <p className="body" style={{ margin: "0 0 16px", maxWidth: 640 }}>
              Our own software: subscriptions and seats, GST quotes and invoices, renewals on autopilot, bank reconciliation — free during beta.
            </p>
            <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
              <Link href="/reselleros" className="btn btn-os">Explore ResellerOS →</Link>
              <Link href="/login" style={{ fontWeight: 600, color: "var(--accent)" }}>Already a member? Log in</Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

