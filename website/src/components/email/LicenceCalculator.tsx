"use client";
/**
 * The email page's licence calculator — six edition chips, two term chips, a 1–300 seat
 * slider, and a live GST-split total.
 *
 * TERM MATTERS HERE, and the words must say so. This site is made by the company whose
 * OTHER product (ResellerOS) once mailed a monthly quotation that never said "monthly" —
 * that defect is documented in production/src/lib/email/quote-body.ts. The calculator
 * therefore names the term on every figure: per-seat rate, monthly subtotal, and the
 * yearly line, each with its unit.
 */
import { useState } from "react";
import Link from "next/link";
import { useCart } from "@/components/cart/CartProvider";
import { rupee, GST_RATE } from "@/lib/money";
import { LICENCE_EDITIONS } from "@/lib/data/catalog";
import type { MergedEdition } from "@/lib/live-catalog";

export function LicenceCalculator({
  editions,
}: {
  /* Merged on the SERVER: live GW prices from the app's catalogue over the placeholders
     (lib/live-catalog.ts). This component only renders what it is handed. */
  editions?: MergedEdition[];
}) {
  const list: MergedEdition[] = editions ?? LICENCE_EDITIONS.map((e) => ({ ...e, monthlyOrNull: e.monthly }));
  const [editionName, setEditionName] = useState(list[1]?.name ?? list[0].name);
  const [term, setTerm] = useState<"Annual" | "Monthly">("Annual");
  const [seats, setSeats] = useState(20);
  const cart = useCart();

  const edition = list.find((e) => e.name === editionName) ?? list[0];
  /* A live product with no flexible tier CANNOT be priced monthly — the term falls back to
     Annual rather than showing an invented figure. That boundary (annual vs monthly rate)
     is the 12× mistake the app has already paid for once. */
  const monthlyAvailable = edition.monthlyOrNull !== null && edition.monthlyOrNull !== undefined
    ? true
    : false;
  const effectiveTerm = term === "Monthly" && !monthlyAvailable ? "Annual" : term;
  const isAnnual = effectiveTerm === "Annual";
  /* Storage per-seat-per-MONTH hai (app ke items.msrp jaisa); annual par dikhaya
     per-seat-per-YEAR jata hai — ×12, wahi jo quotation par chhapta hai. */
  const perSeatMo = isAnnual ? edition.annual : (edition.monthlyOrNull ?? edition.monthly);
  const perSeatShown = isAnnual ? perSeatMo * 12 : perSeatMo;
  const periodTotal = perSeatShown * seats;          // saal ka ya mahine ka, term ke hisaab se
  const gst = periodTotal * GST_RATE;
  const unitWord = isAnnual ? "yr" : "mo";

  return (
    <div className="wrap" id="calculator" style={{ display: "grid", gridTemplateColumns: "1.1fr .9fr", gap: 32, alignItems: "start" }} data-grid>
      <div style={{ background: "var(--tint)", border: "1px solid var(--border)", borderRadius: 10, padding: 26 }}>
        <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 12 }}>PICK AN EDITION</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
          {list.map((e) => (
            <button key={e.name} className="chip" aria-pressed={e.name === editionName} onClick={() => setEditionName(e.name)} title={e.note}>
              {e.name}{e.live ? " ●" : ""}
            </button>
          ))}
        </div>
        <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 12 }}>COMMITMENT</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          <button className="chip chip-primary" aria-pressed={term === "Annual"} onClick={() => setTerm("Annual")}>
            Annual commitment
          </button>
          <button
            className="chip chip-primary"
            aria-pressed={effectiveTerm === "Monthly"}
            disabled={!monthlyAvailable}
            style={!monthlyAvailable ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
            onClick={() => monthlyAvailable && setTerm("Monthly")}
          >
            Monthly, flexible
          </button>
        </div>
        <div className="meta" style={{ marginBottom: 20 }}>
          {!monthlyAvailable
            ? "This edition is priced for annual commitment only"
            : effectiveTerm === "Annual"
              ? "Annual commitment · cheaper per seat than the flexible rate"
              : "Monthly · cancel or resize any month"}
          {edition.live ? " · price from our live catalogue" : " · indicative price"}
        </div>
        <label className="mono-label" style={{ color: "var(--text-muted)", display: "block", marginBottom: 8 }}>
          HOW MANY PEOPLE — {seats}
        </label>
        <input
          type="range"
          min={1}
          max={300}
          value={seats}
          onChange={(e) => setSeats(+e.target.value)}
          style={{ width: "100%", accentColor: "var(--primary)" }}
          aria-label="Number of seats"
        />
      </div>

      {/* Sticky — slider ghumate waqt hisaab saamne tika rahe. */}
      <div className="card" style={{ padding: 26, position: "sticky", top: 84 }}>
        <Row label={edition.name} detail={`${seats} seats × ${rupee(perSeatShown)}/seat/${isAnnual ? "yr (annual commitment)" : "mo (flexible)"}`} amount={rupee(periodTotal)} />
        <Row label="Setup and DNS" detail="MX, SPF, DKIM, DMARC configured and tested" amount="Free" />
        <Row label="Migration" detail="Mail, folders and calendars moved by us" amount="Free" />
        <div style={{ borderTop: "1px solid var(--border)", margin: "14px 0", paddingTop: 14 }}>
          <Line label={isAnnual ? "Per year, before GST" : "Per month, before GST"} value={rupee(periodTotal)} />
          <Line label="GST 18%" value={rupee(gst)} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 0" }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{isAnnual ? "Payable per year" : "Payable per month"}</span>
            <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em" }}>{rupee(periodTotal + gst)}</span>
          </div>
          <div className="meta">
            {isAnnual
              ? `${rupee(perSeatMo)}/seat/month equivalent · GST shown separately, as on the invoice`
              : `${rupee(periodTotal * 12 * (1 + GST_RATE))} across a year, GST included`}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            className="btn btn-primary"
            onClick={() =>
              cart.add(
                isAnnual
                  ? {
                      /* Annual commitment, saal ka daam, saal me renew — cart bhi wahi
                         bole jo quotation bolegi. */
                      label: edition.name,
                      detail: "annual commitment · setup and migration free",
                      unitPrice: perSeatShown,
                      qty: seats,
                      unit: "seat/year",
                      cycle: "yearly",
                    }
                  : {
                      label: edition.name,
                      detail: "monthly, flexible · setup and migration free",
                      unitPrice: perSeatMo,
                      qty: seats,
                      unit: "seat/month",
                      cycle: "monthly",
                    },
              )
            }
          >
            Add to cart
          </button>
          {/* Poora chunav saath jata hai — edition, seats, term. Pehle ye khaali /quote tha
             aur Pardeep ne wahi pakda: form par edition ka option hi nahi tha, to quote kis
             cheez ki jati? Ab form yahi selection khula milta hai. */}
          <Link
            href={{ pathname: "/quote", query: { edition: edition.name, seats: String(seats), term: isAnnual ? "annual" : "monthly" } }}
            className="btn btn-outline"
          >
            Get this as a quote
          </Link>
        </div>
      </div>
    </div>
  );
}

function Row({ label, detail, amount }: { label: string; detail: string; amount: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--border-hairline)" }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{label}</div>
        <div className="meta">{detail}</div>
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: amount === "Free" ? "var(--success)" : "var(--text)" }}>{amount}</div>
    </div>
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
