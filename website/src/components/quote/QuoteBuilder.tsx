"use client";
/**
 * The quote page: form on the left, live quote document on the right, print-to-PDF after
 * generating — the handoff's behaviour — plus the one thing the handoff could not do:
 * on Generate, the enquiry is POSTED to ResellerOS through /api/enquiry, so it lands in
 * the sales pipeline as a lead. The on-screen document is an ESTIMATE and says so; the
 * binding GST quotation is produced by the app and emailed.
 *
 * Quote number Q-ADPL-2026-<0100 + seats> — the handoff's deterministic placeholder scheme,
 * kept deliberately: a browser page must not pretend to own a CGST-compliant series. The
 * real gapless number is minted by ResellerOS when the actual quotation is raised.
 */
import { useState } from "react";
import { rupee, GST_RATE } from "@/lib/money";
import { MAIL_RATES } from "@/lib/data/catalog";

const PRODUCTS = ["Anutech Mail", "Google Workspace", "Microsoft 365", "Hosting", "Domains"] as const;
type Product = (typeof PRODUCTS)[number];

const SEAT_LABELS: Partial<Record<Product, string>> = {
  Domains: "HOW MANY DOMAINS",
  Hosting: "HOW MANY MAILBOXES ALONGSIDE",
};

/** What the app's enquiry API calls each product. "other" for the non-licence ones. */
const API_PRODUCT: Record<Product, "google-workspace" | "microsoft-365" | "other"> = {
  "Anutech Mail": "other",
  "Google Workspace": "google-workspace",
  "Microsoft 365": "microsoft-365",
  Hosting: "other",
  Domains: "other",
};

interface QuoteLine { label: string; detail: string; qty: number; amount: string; raw: number }

function linesFor(product: Product, seats: number): QuoteLine[] {
  if (product === "Hosting") {
    return [
      { label: "Business hosting", detail: "cPanel, 50 GB NVMe, 10 sites", qty: 1, amount: rupee(359), raw: 359 },
      { label: "Anutech Mail", detail: "Mailboxes for the team", qty: seats, amount: rupee(79 * seats), raw: 79 * seats },
    ];
  }
  if (product === "Domains") {
    return [{ label: "Domain portfolio", detail: "Transfer in, ₹649 average per name", qty: seats, amount: rupee(649 * seats), raw: 649 * seats }];
  }
  const rate = MAIL_RATES[product] ?? 165;
  return [
    { label: product, detail: "Per mailbox, per month", qty: seats, amount: rupee(rate * seats), raw: rate * seats },
    { label: "Migration", detail: "Mail, folders and calendars moved by us", qty: 1, amount: "Free", raw: 0 },
  ];
}

export function QuoteBuilder() {
  const [product, setProduct] = useState<Product>("Google Workspace");
  const [seats, setSeats] = useState(25);
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [provider, setProvider] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "issued" | "failed">("idle");
  const [error, setError] = useState("");

  const lines = linesFor(product, seats);
  const sub = lines.reduce((n, l) => n + l.raw, 0);

  const submit = async () => {
    setError("");
    if (name.trim().length < 2 || company.trim().length < 2 || !email.includes("@") || phone.trim().length < 10) {
      setError("Name, company, a valid email and a 10-digit phone are needed — that is where the real quotation goes.");
      return;
    }
    setState("sending");
    try {
      const res = await fetch("/api/enquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: name,
          companyName: company,
          email,
          phone,
          product: API_PRODUCT[product],
          seats,
          requirement:
            `${product} for ${seats} ${product === "Domains" ? "domains" : "seats"}` +
            (provider.trim() ? ` — currently on ${provider.trim()}` : "") +
            " (via anutech.in quote page)",
        }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(data.error || "refused");
      setState("issued");
    } catch (e) {
      setState("failed");
      setError(e instanceof Error && e.message !== "refused" ? e.message : "Could not send the enquiry — WhatsApp us and we will price it by hand.");
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1.1fr", gap: 40, alignItems: "start" }} data-grid>
      {/* ── Form ─────────────────────────────────────────────────────────── */}
      <div>
        <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 10 }}>WHAT IS THIS FOR</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
          {PRODUCTS.map((p) => (
            <button key={p} className="chip" aria-pressed={product === p} onClick={() => { setProduct(p); setState("idle"); }}>
              {p}
            </button>
          ))}
        </div>

        <label className="mono-label" style={{ color: "var(--text-muted)", display: "block", marginBottom: 8 }}>
          {SEAT_LABELS[product] ?? "HOW MANY MAILBOXES"} — {seats}
        </label>
        <input
          type="range" min={1} max={300} value={seats}
          onChange={(e) => { setSeats(+e.target.value); setState("idle"); }}
          style={{ width: "100%", accentColor: "var(--primary)", marginBottom: 20 }}
          aria-label="How many"
        />

        <Field label="Your name" value={name} onChange={setName} />
        <Field label="Company" value={company} onChange={setCompany} />
        <Field label="Email — the quotation goes here" value={email} onChange={setEmail} type="email" />
        <Field label="Mobile" value={phone} onChange={setPhone} type="tel" />
        <Field label="Current provider (optional)" value={provider} onChange={setProvider} />

        {error && <p style={{ color: "var(--danger)", fontSize: 14 }}>{error}</p>}

        <button className="btn btn-primary" style={{ width: "100%", marginTop: 6 }} onClick={submit} disabled={state === "sending"}>
          {state === "sending" ? "Sending…" : state === "issued" ? "Sent — check your inbox" : "Generate my quote"}
        </button>

        {state === "issued" && (
          <div style={{ marginTop: 16, border: "1px solid var(--success)", background: "#EEF7F0", borderRadius: 8, padding: 16 }}>
            <div className="mono-label" style={{ color: "var(--success)", marginBottom: 6 }}>ENQUIRY RECORDED</div>
            <p style={{ fontSize: 14, lineHeight: 1.5, margin: 0, color: "var(--text-secondary)" }}>
              The estimate on the right is indicative. The formal GST quotation — numbered, CGST/SGST
              split, PDF attached — is prepared in our system and emailed to {email || "you"}, usually
              within minutes in working hours.
            </p>
            <button className="btn btn-outline btn-sm" style={{ marginTop: 10 }} onClick={() => window.print()}>
              Print this estimate
            </button>
          </div>
        )}
      </div>

      {/* ── Live estimate document ───────────────────────────────────────── */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ background: "var(--dark)", color: "#fff", padding: "18px 22px", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontSize: 16, fontWeight: 700 }}>Anutech Digital</span>
          <span className="mono" style={{ fontSize: 13, color: "#9AA5B1" }}>
            EST-{String(100 + seats).padStart(4, "0")} · ESTIMATE
          </span>
        </div>
        <div style={{ padding: 22 }}>
          <div style={{ display: "flex", gap: 30, marginBottom: 18 }}>
            <div>
              <div className="mono-label" style={{ color: "var(--text-muted)" }}>ESTIMATE FOR</div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{name.trim() || "Your name"}</div>
              <div className="meta">{company.trim() || "Your company"}</div>
            </div>
            <div>
              <div className="mono-label" style={{ color: "var(--text-muted)" }}>VALID UNTIL</div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>15 Sep 2026</div>
            </div>
          </div>
          {lines.map((l) => (
            <div key={l.label} style={{ display: "flex", gap: 10, padding: "10px 0", borderTop: "1px solid var(--border-hairline)" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{l.label}</div>
                <div className="meta">{l.detail}</div>
              </div>
              <span className="meta">× {l.qty}</span>
              <span style={{ fontSize: 15, fontWeight: 600, color: l.amount === "Free" ? "var(--success)" : "var(--text)" }}>{l.amount}</span>
            </div>
          ))}
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 6, paddingTop: 12 }}>
            <Line label="Subtotal, per month" value={rupee(sub)} />
            <Line label="GST 18%" value={rupee(sub * GST_RATE)} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 0" }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>Total, per month</span>
              <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em" }}>{rupee(sub * (1 + GST_RATE))}</span>
            </div>
          </div>
          <p className="meta" style={{ marginTop: 12 }}>
            {provider.trim()
              ? `Moving from ${provider.trim()} — migration is included at no charge and scheduled outside your business hours.`
              : "Migration from your current provider is included at no charge. GST 18% shown separately; GSTIN appears on the invoice."}
          </p>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <span className="mono-label" style={{ color: "var(--text-muted)", display: "block", marginBottom: 6 }}>{label.toUpperCase()}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "11px 12px", fontSize: 15, fontFamily: "inherit" }}
      />
    </label>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: "var(--text-secondary)", padding: "2px 0" }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
