"use client";
/** Order confirmation. The order number comes from sessionStorage (set at checkout). */
import Link from "next/link";
import { useEffect, useState } from "react";

export default function DonePage() {
  const [orderNo, setOrderNo] = useState("ORD-ADPL-2026-4107");
  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem("anutech.order");
      if (saved) setOrderNo(saved);
    } catch { /* default shown */ }
  }, []);

  return (
    <section className="section rise">
      <div className="wrap" style={{ maxWidth: 640 }}>
        <div className="mono-label" style={{ display: "inline-block", padding: "8px 14px", borderRadius: 999, background: "#EEF7F0", color: "var(--success)", border: "1px solid var(--success)", marginBottom: 22 }}>
          ORDER PLACED
        </div>
        <h1 className="h1-narrow" style={{ marginBottom: 14 }}>
          Done — order <span className="mono">{orderNo}</span> is with us.
        </h1>
        <p className="body-lg" style={{ margin: "0 0 10px" }}>
          The GST invoice and receipt reach your inbox shortly. UPI, netbanking and card orders
          activate immediately; NEFT and RTGS activate when the credit lands.
        </p>
        <p className="body-lg" style={{ margin: "0 0 26px" }}>
          If a migration is part of the order, the migration desk messages you on WhatsApp today to
          schedule it — outside your business hours.
        </p>
        <div style={{ display: "flex", gap: 12 }}>
          <Link href="/dashboard" className="btn btn-primary">Open the client area</Link>
          <Link href="/" className="btn btn-outline">Back to home</Link>
        </div>
      </div>
    </section>
  );
}
