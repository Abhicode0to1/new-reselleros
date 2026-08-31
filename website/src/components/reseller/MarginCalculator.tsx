"use client";
/**
 * The wholesale margin calculator: three sliders → per-product buy/sell/margin rows →
 * monthly margin at 42px plus the yearly figure. Assumptions live in data/catalog.ts
 * (MARGIN), not here — a component that carries its own prices is how two pages come to
 * disagree about the same number.
 */
import { useState } from "react";
import Link from "next/link";
import { rupee } from "@/lib/money";
import { MARGIN } from "@/lib/data/catalog";

export function MarginCalculator() {
  const [domains, setDomains] = useState(40);
  const [sites, setSites] = useState(15);
  const [mailboxes, setMailboxes] = useState(120);

  const rows = [
    { ...MARGIN.domains, count: domains },
    { ...MARGIN.sites, count: sites },
    { ...MARGIN.mailboxes, count: mailboxes },
  ];
  const monthly = rows.reduce((n, r) => n + r.count * r.perUnit, 0);

  return (
    <div className="wrap-inner" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32, alignItems: "start" }} data-grid>
      <div className="card">
        <Slider label={`DOMAINS UNDER MANAGEMENT — ${domains}`} min={1} max={300} value={domains} onChange={setDomains} />
        <Slider label={`SITES HOSTED — ${sites}`} min={1} max={120} value={sites} onChange={setSites} />
        <Slider label={`MAILBOXES — ${mailboxes}`} min={0} max={500} value={mailboxes} onChange={setMailboxes} />
      </div>

      <div className="card">
        {rows.map((r) => (
          <div key={r.label} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "10px 0", borderBottom: "1px solid var(--border-hairline)", fontSize: 14 }}>
            <span style={{ fontWeight: 600 }}>{r.label}</span>
            <span className="meta">buy {rupee(r.cost)} · sell {rupee(r.retail)}</span>
            <span style={{ fontWeight: 600, color: "var(--success)" }}>{r.count > 0 ? rupee(r.count * r.perUnit) : "—"}</span>
          </div>
        ))}
        <div style={{ marginTop: 18 }}>
          <div className="mono-label" style={{ color: "var(--text-muted)" }}>YOUR MONTHLY MARGIN</div>
          <div style={{ fontSize: 42, fontWeight: 700, letterSpacing: "-0.04em" }}>{rupee(monthly)}</div>
          <div className="meta" style={{ marginBottom: 16 }}>{rupee(monthly * 12)} a year, at the published rates</div>
          <Link href="/pricing" className="btn btn-primary">See the full rate card</Link>
        </div>
      </div>
    </div>
  );
}

function Slider({ label, min, max, value, onChange }: { label: string; min: number; max: number; value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <label className="mono-label" style={{ color: "var(--text-muted)", display: "block", marginBottom: 8 }}>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
        style={{ width: "100%", accentColor: "var(--primary)" }}
        aria-label={label}
      />
    </div>
  );
}
