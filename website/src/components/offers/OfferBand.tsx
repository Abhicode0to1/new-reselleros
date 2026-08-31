"use client";
/**
 * The ".in ₹1" offer band — client-side ON PURPOSE.
 *
 * The offer expires by DATE, and the pages that show it are statically rendered: a
 * server-rendered band would freeze whatever the date was at BUILD time, and the ₹1
 * banner would keep selling into October until someone happened to deploy. In the
 * browser the date is the visitor's own now, so the band disappears at the real
 * boundary. (The /pricing table cell is server-rendered and carries an hourly
 * revalidate for the same reason — ≤1h of boundary staleness, stated, not hidden.)
 *
 * Renders nothing when no offer is live — an empty green stripe would train visitors
 * to ignore the real one.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { TLDS } from "@/lib/data/catalog";
import { effectiveReg } from "@/lib/offers";
import { rupee } from "@/lib/money";

export function OfferBand({ variant = "band" }: { variant?: "band" | "pill" }) {
  /* Mounted-gate: the server HTML must not contain the band (build-time date would decide
     it); it appears after hydration, from the visitor's clock. */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const inTld = TLDS.find((t) => t.tld === ".in");
  if (!inTld) return null;
  const p = effectiveReg(".in", inTld.reg);
  if (!p.offer) return null;

  if (variant === "pill") {
    return (
      <div className="mono-label" style={{ display: "inline-block", marginBottom: 16, padding: "8px 14px", borderRadius: 999, background: "#EEF7F0", color: "var(--success)", border: "1px solid var(--success)" }}>
        {p.offer.label} — .IN ₹1 FIRST YEAR (RENEWS {rupee(inTld.renew)}/YR) · TILL 30 SEP
      </div>
    );
  }

  return (
    <Link
      href="/domains"
      style={{
        display: "block", background: "#0F7B4F", color: "#fff",
        padding: "11px 20px", textAlign: "center", fontSize: 15, fontWeight: 600,
      }}
    >
      🎉 <span className="mono" style={{ letterSpacing: "0.06em" }}>{p.offer.label}</span> — .in domain{" "}
      <s style={{ opacity: 0.7, fontWeight: 400 }}>{rupee(p.offer.was)}</s> <b>₹1</b> first year
      <span style={{ opacity: 0.85, fontWeight: 400 }}> (renews {rupee(inTld.renew)}/yr) · till 30 Sep — claim yours →</span>
    </Link>
  );
}
