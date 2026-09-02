"use client";
/**
 * The quote page: form on the left, live estimate on the right, and on Generate the
 * enquiry POSTs to ResellerOS through /api/enquiry — a lead in the sales pipeline.
 *
 * ─── WHY THE PRODUCTS ARE EDITIONS NOW ──────────────────────────────────────
 * The first version copied the handoff's five coarse chips ("Google Workspace", …).
 * Pardeep clicked "Get this as a quote" from the licence calculator and found his
 * selection gone: "usme sirf google workspace hota hai, product selection ka to option
 * hi nahi — bina product ke quote kaise jayenge". He is right: a licence quotation
 * without the EDITION is not a quotation.
 *
 * So the licence chips are the same live-merged editions the calculator shows (GW rows
 * carry the app catalogue's real prices — the ● mark), plus Anutech Mail, Hosting and
 * Domains. The calculator hands its whole selection over in the URL
 * (?edition=…&seats=…&term=…), so what you configured is what gets quoted.
 *
 * The on-screen document is an ESTIMATE and says so; the binding GST quotation with the
 * real CGST-series number is produced by the app and emailed.
 */
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { rupee, GST_RATE } from "@/site/lib/money";
import { MAIL_RATES, LICENCE_EDITIONS } from "@/site/lib/data/catalog";
import { apiProductFor } from "@/site/lib/quote-mapping";
import type { MergedEdition } from "@/site/lib/live-catalog";

const FIXED_PRODUCTS = ["Anutech Mail", "Hosting", "Domains"] as const;

interface QuoteLine { label: string; detail: string; qty: number; amount: string; raw: number }

export function QuoteBuilder({ editions }: { editions?: MergedEdition[] }) {
  const list: MergedEdition[] =
    editions ?? LICENCE_EDITIONS.map((e) => ({ ...e, monthlyOrNull: e.monthly }));
  const products: string[] = [...list.map((e) => e.name), ...FIXED_PRODUCTS];

  /* The calculator's handover: /quote?edition=GW+Business+Standard&seats=20&term=annual.
     An unknown edition name falls back to the first product rather than erroring — the
     link may be old, the catalogue may have changed. */
  const params = useSearchParams();
  const paramEdition = params.get("edition");
  const initialProduct =
    paramEdition && products.includes(paramEdition) ? paramEdition : list[0]?.name ?? FIXED_PRODUCTS[0];
  const paramSeats = Number(params.get("seats"));
  const initialSeats = Number.isFinite(paramSeats) && paramSeats >= 1 && paramSeats <= 300 ? Math.floor(paramSeats) : 25;
  const initialTerm: "annual" | "monthly" = params.get("term") === "monthly" ? "monthly" : "annual";

  const [product, setProduct] = useState<string>(initialProduct);
  const [term, setTerm] = useState<"annual" | "monthly">(initialTerm);
  const [seats, setSeats] = useState(initialSeats);
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [provider, setProvider] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "issued" | "failed">("idle");
  /* Auto-quote path se aaya draft ka number — green panel isse NAAM se batata hai. */
  const [quoteId, setQuoteId] = useState<string | null>(null);
  /* Panel ko wo pata chahiye jis par bheja — form success par KHALI ho jata hai (Pardeep:
     "enquiry recorded ho jaye to form khali ho jana chahiye"), to email state se nahi,
     yahan se aata hai. */
  const [sentTo, setSentTo] = useState("");
  /* True jab quotation SACH ME email ho chuki (app ke gates paar karke) — panel ka vaakya
     isi par badalta hai. Draft-hold par jhooth me "emailed" kehna bharosa todta. */
  const [wasSent, setWasSent] = useState(false);
  const [error, setError] = useState("");

  const edition = list.find((e) => e.name === product) ?? null;
  /* Same honesty rule as the calculator: no flexible tier in the catalogue → no monthly
     figure gets invented; the term snaps to annual and the chip disables. */
  const monthlyAvailable = edition ? edition.monthlyOrNull != null : true;
  const effectiveTerm = edition && term === "monthly" && !monthlyAvailable ? "annual" : term;
  const isAnnual = effectiveTerm === "annual";

  const seatLabel =
    product === "Domains" ? "HOW MANY DOMAINS" : product === "Hosting" ? "HOW MANY MAILBOXES ALONGSIDE" : "HOW MANY SEATS";

  function lines(): QuoteLine[] {
    if (product === "Hosting") {
      return [
        { label: "Business hosting", detail: "cPanel, 50 GB NVMe, 10 sites", qty: 1, amount: rupee(359), raw: 359 },
        { label: "Anutech Mail", detail: "Mailboxes for the team", qty: seats, amount: rupee(79 * seats), raw: 79 * seats },
      ];
    }
    if (product === "Domains") {
      return [{ label: "Domain portfolio", detail: "Transfer in, ₹649 average per name", qty: seats, amount: rupee(649 * seats), raw: 649 * seats }];
    }
    if (product === "Anutech Mail") {
      return [
        { label: "Anutech Mail", detail: "Per mailbox, per month", qty: seats, amount: rupee(MAIL_RATES["Anutech Mail"] * seats), raw: MAIL_RATES["Anutech Mail"] * seats },
        { label: "Migration", detail: "Mail, folders and calendars moved by us", qty: 1, amount: "Free", raw: 0 },
      ];
    }
    /* A licence edition. Annual speaks per YEAR — the unit the real quotation uses. */
    const e = edition!;
    const perSeat = isAnnual ? e.annual * 12 : (e.monthlyOrNull ?? e.monthly);
    const unit = isAnnual ? "yr" : "mo";
    return [
      {
        label: e.name,
        detail: `${rupee(perSeat)}/seat/${unit} · ${isAnnual ? "annual commitment" : "monthly, flexible"}${e.live ? " · live catalogue price" : " · indicative"}`,
        qty: seats,
        amount: rupee(perSeat * seats),
        raw: perSeat * seats,
      },
      { label: "Migration", detail: "Mail, folders and calendars moved by us", qty: 1, amount: "Free", raw: 0 },
    ];
  }

  const quoteLines = lines();
  const sub = quoteLines.reduce((n, l) => n + l.raw, 0);
  const periodWord = edition ? (isAnnual ? "per year" : "per month") : "per month";

  const submit = async () => {
    setError("");
    if (name.trim().length < 2 || company.trim().length < 2 || !email.includes("@") || phone.trim().length < 10) {
      setError("Name, company, a valid email and a 10-digit phone are needed — that is where the real quotation goes.");
      return;
    }
    setState("sending");
    try {
      const requirement =
        (edition
          ? `${edition.name}, ${isAnnual ? "annual commitment" : "monthly flexible"}, ${seats} seats`
          : `${product} for ${seats} ${product === "Domains" ? "domains" : "seats"}`) +
        (provider.trim() ? ` — currently on ${provider.trim()}` : "") +
        " (via anutech.in quote page)";
      const res = await fetch("/api/enquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: name,
          companyName: company,
          email,
          phone,
          product: apiProductFor(product),
          seats,
          requirement,
          /* GW edition + term → proxy inhe dekh kar AUTO-QUOTE raaste par bhejta hai:
             app me lead ke saath catalog-priced draft quotation banti hai. */
          edition: edition?.name,
          term: effectiveTerm,
        }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string; quoteId?: string | null; sent?: boolean };
      if (!data.ok) throw new Error(data.error || "refused");
      setQuoteId(data.quoteId ?? null);
      setWasSent(data.sent === true);
      setSentTo(email);
      setState("issued");
      /* Agli enquiry ke liye saaf slate — bhara hua form dobara Generate dabane par wahi
         lead phir bana deta. Green panel sentTo se apna vaakya poora rakhta hai. */
      setName("");
      setCompany("");
      setEmail("");
      setPhone("");
      setProvider("");
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
          {products.map((p) => {
            const live = list.find((e) => e.name === p)?.live;
            return (
              <button key={p} className="chip" aria-pressed={product === p} onClick={() => { setProduct(p); setState("idle"); }}>
                {p}{live ? " ●" : ""}
              </button>
            );
          })}
        </div>

        {edition && (
          <>
            <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 10 }}>COMMITMENT</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <button className="chip chip-primary" aria-pressed={isAnnual} onClick={() => { setTerm("annual"); setState("idle"); }}>
                Annual commitment
              </button>
              <button
                className="chip chip-primary"
                aria-pressed={!isAnnual}
                disabled={!monthlyAvailable}
                style={!monthlyAvailable ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
                onClick={() => { if (monthlyAvailable) { setTerm("monthly"); setState("idle"); } }}
              >
                Monthly, flexible
              </button>
            </div>
            <div className="meta" style={{ marginBottom: 16 }}>
              {!monthlyAvailable ? "This edition is priced for annual commitment only" : isAnnual ? "Cheaper per seat than the flexible rate" : "Cancel or resize any month"}
            </div>
          </>
        )}

        <label className="mono-label" style={{ color: "var(--text-muted)", display: "block", marginBottom: 8 }}>
          {seatLabel} — {seats}
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
              {quoteId && wasSent ? (
                <>Quotation <b className="mono">{quoteId}</b> has been <b>emailed to {sentTo || "you"}</b> with
                the GST document attached — it should be in the inbox within a minute or two.</>
              ) : quoteId ? (
                <>Quotation <b className="mono">{quoteId}</b> has been drafted in our system with the
                catalogue price — it reaches {sentTo || "you"} after a quick review, usually within
                working hours the same day.</>
              ) : (
                <>The estimate on the right is indicative. We price the requirement in our system and
                the formal GST quotation reaches {sentTo || "you"} the same working day.</>
              )}
            </p>
            <button className="btn btn-outline btn-sm" style={{ marginTop: 10 }} onClick={() => window.print()}>
              Print this estimate
            </button>
          </div>
        )}
      </div>

      {/* ── Live estimate document ───────────────────────────────────────────
         Sticky: form lamba hai aur bharte waqt aankhein aankdon par rehni chahiye —
         Pardeep: "form bharte jab neeche scroll kare to view uske saath scroll ho".
         top 84 = sticky header (68) + saans. Grid parent par alignItems:start pehle se
         hai — wahi sticky ko chalne deta hai. 980px se neeche grid ek column ho jata
         hai aur sticky ke paas sarakne ki jagah hi nahi bachti, to wahan ye harmless
         no-op hai. */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", position: "sticky", top: 84 }}>
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
          {quoteLines.map((l) => (
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
            <Line label={`Subtotal, ${periodWord}`} value={rupee(sub)} />
            <Line label="GST 18%" value={rupee(sub * GST_RATE)} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 0" }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>Total, {periodWord}</span>
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
