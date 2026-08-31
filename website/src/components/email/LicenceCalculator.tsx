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

export function LicenceCalculator() {
  const [editionName, setEditionName] = useState(LICENCE_EDITIONS[1].name);
  const [term, setTerm] = useState<"Annual" | "Monthly">("Annual");
  const [seats, setSeats] = useState(20);
  const cart = useCart();

  const edition = LICENCE_EDITIONS.find((e) => e.name === editionName) ?? LICENCE_EDITIONS[1];
  const perSeat = term === "Annual" ? edition.annual : edition.monthly;
  const monthly = perSeat * seats;
  const gst = monthly * GST_RATE;

  return (
    <div className="wrap" id="calculator" style={{ display: "grid", gridTemplateColumns: "1.1fr .9fr", gap: 32, alignItems: "start" }} data-grid>
      <div style={{ background: "var(--tint)", border: "1px solid var(--border)", borderRadius: 10, padding: 26 }}>
        <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 12 }}>PICK AN EDITION</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
          {LICENCE_EDITIONS.map((e) => (
            <button key={e.name} className="chip" aria-pressed={e.name === editionName} onClick={() => setEditionName(e.name)} title={e.note}>
              {e.name}
            </button>
          ))}
        </div>
        <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 12 }}>COMMITMENT</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          <button className="chip chip-primary" aria-pressed={term === "Annual"} onClick={() => setTerm("Annual")}>
            Annual commitment
          </button>
          <button className="chip chip-primary" aria-pressed={term === "Monthly"} onClick={() => setTerm("Monthly")}>
            Monthly, flexible
          </button>
        </div>
        <div className="meta" style={{ marginBottom: 20 }}>
          {term === "Annual" ? "Annual commitment · 15% under monthly rate" : "Monthly · cancel or resize any month"}
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

      <div className="card" style={{ padding: 26 }}>
        <Row label={edition.name} detail={`${seats} seats × ${rupee(perSeat)}/seat/${term === "Annual" ? "mo (annual commitment)" : "mo (flexible)"}`} amount={rupee(monthly)} />
        <Row label="Setup and DNS" detail="MX, SPF, DKIM, DMARC configured and tested" amount="Free" />
        <Row label="Migration" detail="Mail, folders and calendars moved by us" amount="Free" />
        <div style={{ borderTop: "1px solid var(--border)", margin: "14px 0", paddingTop: 14 }}>
          <Line label="Per month" value={rupee(monthly)} />
          <Line label="GST 18%" value={rupee(gst)} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 0" }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>Payable per month</span>
            <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em" }}>{rupee(monthly + gst)}</span>
          </div>
          <div className="meta">{rupee(monthly * 12 * (1 + GST_RATE))} across a year, GST included</div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            className="btn btn-primary"
            onClick={() =>
              cart.add({
                label: edition.name,
                detail: `${term.toLowerCase()} commitment · setup and migration free`,
                unitPrice: perSeat,
                qty: seats,
                unit: "seat/month",
                cycle: "monthly",
              })
            }
          >
            Add to cart
          </button>
          <Link href="/quote" className="btn btn-outline">Get this as a quote</Link>
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
